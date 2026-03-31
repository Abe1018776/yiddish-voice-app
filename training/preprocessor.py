"""
Dataset preprocessor for Whisper fine-tuning.

Adapted from ivrit-ai/asr-training's DatasetPreparator. Handles:
- Audio feature extraction (mel spectrograms)
- Efficient padding/compression of audio features
- Timestamp token injection (synthetic start/end timestamps)
- Previous text conditioning
- Random augmentation decisions per example
- Label tokenization with proper Whisper prefix tokens

Reference: https://github.com/ivrit-ai/asr-training/blob/master/preprocess/preperator.py
"""

import numpy as np
import torch
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Union

from datasets import Audio, Dataset, DatasetDict, Features, Sequence, Value, concatenate_datasets
from transformers import BatchFeature, WhisperProcessor


# Whisper's max decoder sequence length (all model sizes)
WHISPER_MAX_TARGET_POSITIONS = 448


def shift_audio_forward(audio_array: np.ndarray, shift_seconds: float, sample_rate: int) -> np.ndarray:
    """Shift audio forward by prepending silence."""
    shift_samples = int(shift_seconds * sample_rate)
    if shift_samples <= 0:
        return audio_array
    silence = np.zeros(shift_samples, dtype=audio_array.dtype)
    return np.concatenate([silence, audio_array])


class DatasetPreparator:
    """Prepares a HuggingFace dataset for Whisper fine-tuning.

    Each example is transformed into:
    - input_features: mel spectrogram features (compressed padding)
    - labels: tokenized text with proper Whisper prefix/suffix tokens
    - pad_value/pad_amount: for efficient storage of padded spectrograms
    """

    def __init__(
        self,
        processor: WhisperProcessor,
        tokenizer_time_precision: float = 0.02,
        timestamp_sample_prob: float = 0.5,
        condition_on_prev_sample_prob: float = 0.5,
        proc_num: int = 1,
        device: str = "cpu",
        seed: np.random.RandomState = None,
        inject_synthetic_timestamps: bool = False,
        audio_shift_augmentation: bool = False,
    ):
        if proc_num > 1:
            torch.set_num_threads(1)

        self.seed = np.random.default_rng(998) if seed is None else seed
        self.device = device
        self.processor = processor
        self.tokenizer = processor.tokenizer
        self.proc_num = proc_num
        self.target_sampling_rate = processor.feature_extractor.sampling_rate
        self.tokenizer_time_precision = tokenizer_time_precision

        # Cache prefix tokens for both timestamp modes
        orig_predict_timestamps = self.processor.tokenizer.predict_timestamps
        self.processor.tokenizer.set_prefix_tokens(predict_timestamps=False)
        self.prefix_tokens_no_ts = self.processor.tokenizer.prefix_tokens
        self.processor.tokenizer.set_prefix_tokens(predict_timestamps=True)
        self.prefix_tokens_with_ts = self.processor.tokenizer.prefix_tokens
        self.processor.tokenizer.set_prefix_tokens(predict_timestamps=orig_predict_timestamps)

        # Token IDs
        self.eot_token_id = self.tokenizer.convert_tokens_to_ids("<|endoftext|>")
        self.start_of_prev_token_id = self.tokenizer.convert_tokens_to_ids("<|startofprev|>")
        self.no_timestamp_token_id = self.tokenizer.convert_tokens_to_ids("<|notimestamps|>")
        self.timestamp_begin_token_id = self.no_timestamp_token_id + 1
        self.last_timestamp_token = self.tokenizer.total_vocab_size - 1
        self.total_timestamp_tokens = self.last_timestamp_token - self.timestamp_begin_token_id + 1
        self.max_allowed_tokenized_timestamp = (self.total_timestamp_tokens - 1) * tokenizer_time_precision
        self.prev_ids_max_length = WHISPER_MAX_TARGET_POSITIONS // 2

        # Sampling probabilities
        self.timestamp_sample_prob = timestamp_sample_prob
        self.condition_on_prev_sample_prob = condition_on_prev_sample_prob
        self.inject_synthetic_timestamps = inject_synthetic_timestamps
        self.audio_shift_augmentation = audio_shift_augmentation
        self.max_shifted_audio_ends_at = 29.6

        # Output features schema for efficient disk caching
        self.output_features = Features({
            "input_features": Sequence(feature=Sequence(feature=Value(dtype="float32"))),
            "labels": Sequence(feature=Value(dtype="int32")),
            "pad_value": Sequence(feature=Value(dtype="float32")),
            "pad_amount": Value("int32"),
            "input_length": Value("float64"),
        })

    def _get_token_timestamp_for_time(self, time: float) -> int:
        if self.max_allowed_tokenized_timestamp < time:
            raise ValueError(f"Time {time} exceeds max {self.max_allowed_tokenized_timestamp}")
        return self.timestamp_begin_token_id + int(round(time / self.tokenizer_time_precision))

    def _prepare_example_fn(self, example):
        """Process a single example into Whisper training format."""
        try:
            result = BatchFeature({})

            audio = example["audio"]
            audio_array = audio["array"]
            original_sr = audio["sampling_rate"]
            audio_duration = len(audio_array) / original_sr

            # Resample if needed
            if original_sr != self.target_sampling_rate:
                from torchaudio.transforms import Resample
                resampler = Resample(orig_freq=original_sr, new_freq=self.target_sampling_rate)
                audio_array = resampler(torch.tensor(audio_array).float()).numpy()

            # Audio shift augmentation
            shift = 0.0
            if self.audio_shift_augmentation:
                max_shift = self.max_shifted_audio_ends_at - audio_duration
                if max_shift > 0:
                    shift = round(self.seed.beta(2, 3) * max_shift, 2)
                    audio_array = shift_audio_forward(audio_array, shift, self.target_sampling_rate)

            # Extract mel features
            feat_result = self.processor.feature_extractor(
                audio_array,
                sampling_rate=self.target_sampling_rate,
                return_attention_mask=True,
                device=self.device,
            )
            input_feat = feat_result["input_features"][0]
            attn_mask = feat_result["attention_mask"][0]

            # Compress padding for efficient storage
            if attn_mask[-3] == 0:
                padding_starts = attn_mask.argmin() + 1
                pad_value = input_feat.T[padding_starts]
                input_feat_keep = input_feat.T[:padding_starts].T
                pad_amount = np.int32(input_feat.shape[-1] - padding_starts)
            else:
                input_feat_keep = input_feat
                pad_value = np.array([], dtype=input_feat.dtype)
                pad_amount = np.int32(0)

            result["input_features"] = input_feat_keep
            result["pad_value"] = pad_value
            result["pad_amount"] = pad_amount
            result["input_length"] = len(audio_array) / self.target_sampling_rate

            # Tokenize text
            has_timestamps = example.get("has_timestamps", False)
            has_prev = example.get("has_prev", False)
            text = example["transcript"]

            token_ids = self.tokenizer(
                text,
                add_special_tokens=False,
                add_prefix_space=not has_timestamps,
                return_attention_mask=False,
            )["input_ids"]

            # Decide augmentation for this example
            should_train_on_timestamps = bool(self.seed.binomial(1, self.timestamp_sample_prob))
            should_condition_on_prev = has_prev and bool(self.seed.binomial(1, self.condition_on_prev_sample_prob))

            # Handle timestamps
            if has_timestamps and not should_train_on_timestamps:
                # Strip timestamp tokens
                token_ids = [t for t in token_ids if t < self.timestamp_begin_token_id]

            # Handle previous text
            prev_ids = []
            if should_condition_on_prev and has_prev:
                prev_text = example.get("prev_transcript", "")
                if prev_text:
                    prev_ids = self.tokenizer(
                        prev_text,
                        add_special_tokens=False,
                        add_prefix_space=not has_timestamps,
                        return_attention_mask=False,
                    )["input_ids"]
                    if not should_train_on_timestamps and has_timestamps:
                        prev_ids = [t for t in prev_ids if t < self.timestamp_begin_token_id]

            # Inject synthetic timestamps if needed
            if (should_train_on_timestamps and not has_timestamps
                    and not prev_ids and self.inject_synthetic_timestamps):
                start_ts = self._get_token_timestamp_for_time(shift)
                end_ts = self._get_token_timestamp_for_time(shift + audio_duration)
                token_ids = [start_ts] + token_ids + [end_ts]
                has_timestamps = True

            # Trim prev_ids to fit
            max_prev_len = min(
                WHISPER_MAX_TARGET_POSITIONS - len(token_ids) - 5,
                self.prev_ids_max_length,
            )
            if max_prev_len > 0:
                prev_ids = prev_ids[-max_prev_len:]
            else:
                prev_ids = []

            prev_ids = [self.start_of_prev_token_id] + prev_ids if prev_ids else []

            # Build final label sequence
            with_timestamps = has_timestamps and should_train_on_timestamps
            prefix = self.prefix_tokens_with_ts if with_timestamps else self.prefix_tokens_no_ts
            labels = prev_ids + prefix + token_ids + [self.eot_token_id]

            result["labels"] = labels
            return result

        except Exception as e:
            print(f"Error processing example: {e}")
            return None

    def prepare_dataset(self, dataset: Dataset) -> Dataset:
        """Process an entire dataset split."""
        dataset = dataset.cast_column("audio", Audio(sampling_rate=self.target_sampling_rate))

        columns_to_remove = dataset.column_names

        processed = dataset.map(
            self._prepare_example_fn,
            remove_columns=columns_to_remove,
            num_proc=self.proc_num,
            features=self.output_features,
        )

        # Filter out examples that exceed max target length
        processed = processed.filter(
            lambda labels: len(labels) <= WHISPER_MAX_TARGET_POSITIONS,
            input_columns="labels",
        )

        return processed


def process_datasets(datasets: list, preparator: DatasetPreparator) -> Dataset:
    """Process multiple dataset splits and concatenate them."""
    processed = [preparator.prepare_dataset(ds) for ds in datasets]
    return concatenate_datasets(processed) if len(processed) > 1 else processed[0]


@dataclass
class DataCollatorSpeechSeq2SeqWithPadding:
    """Data collator for Whisper Seq2Seq training.

    Handles:
    - Reconstructing padded audio features from compressed storage
    - Padding label sequences with proper masking (-100 for ignored tokens)
    - Creating decoder_input_ids from labels
    - Masking prompt tokens (previous text) in loss computation
    """
    processor: Any
    decoder_start_token_id: int

    def __call__(self, features: List[Dict[str, Union[List[int], torch.Tensor]]]) -> Dict[str, torch.Tensor]:
        # Reconstruct padded audio features
        input_features = []
        for feature in features:
            pad_amount = feature.get("pad_amount", 0)
            if pad_amount > 0:
                pad_value = feature["pad_value"]
                pad_tensor = torch.tensor([pad_value] * pad_amount).T
                base_features = torch.tensor(feature["input_features"])
                final_features = torch.concatenate([base_features, pad_tensor], dim=-1)
                input_features.append(final_features)
            else:
                input_features.append(torch.tensor(feature["input_features"]))

        batch = BatchFeature({"input_features": torch.stack(input_features)})

        # Pad labels
        label_features = [{"input_ids": feature["labels"]} for feature in features]
        labels_batch = self.processor.tokenizer.pad(label_features, return_tensors="pt")

        labels = labels_batch["input_ids"]
        batch["decoder_input_ids"] = labels[:, :-1]

        labels = labels[:, 1:]
        labels_mask = labels_batch.attention_mask[:, 1:]
        labels = labels.masked_fill(labels_mask.ne(1), -100)

        # Mask prompt tokens (everything before <|startoftranscript|>)
        bos_index = torch.argmax((labels == self.decoder_start_token_id).long(), dim=1)
        bos_index = torch.where(bos_index > 0, bos_index + 1, bos_index)
        prompt_mask = torch.arange(labels.shape[1]) < bos_index[:, None]
        labels = torch.where(prompt_mask, -100, labels)

        batch["labels"] = labels
        return batch
