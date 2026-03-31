#!/usr/bin/env python3
"""
Download and prepare the Yiddish subset of Meta's Omnilingual ASR Corpus
for Whisper fine-tuning.

Source: https://huggingface.co/datasets/facebook/omnilingual-asr-corpus
Config: ydd_Hebr (Yiddish in Hebrew script)

This script:
1. Downloads the Yiddish subset from the Omnilingual ASR Corpus
2. Cleans and normalizes transcriptions
3. Resamples audio to 16kHz (Whisper's expected sample rate)
4. Splits into train/eval sets
5. Saves in a format compatible with the Whisper training pipeline
"""

import argparse
import os
import re
import sys

from datasets import Audio, Dataset, DatasetDict, load_dataset


# Special transcription markers in the Omnilingual ASR corpus
NOISE_TAGS = re.compile(r"<(laugh|hesitation|unintelligible|noise)>")
FALSE_START_PATTERN = re.compile(r"\S+-\s*")  # word fragments like "word-"

WHISPER_SAMPLE_RATE = 16_000


def clean_transcription(text: str, keep_noise_tags: bool = False) -> str:
    """Clean raw transcription text from the Omnilingual ASR corpus.

    Args:
        text: Raw transcription text.
        keep_noise_tags: If True, keep noise/hesitation tags; otherwise remove them.

    Returns:
        Cleaned transcription string.
    """
    if not text or not isinstance(text, str):
        return ""

    cleaned = text.strip()

    if not keep_noise_tags:
        # Remove noise tags like <laugh>, <hesitation>, <unintelligible>, <noise>
        cleaned = NOISE_TAGS.sub("", cleaned)
        # Remove false starts (word fragments ending with -)
        cleaned = FALSE_START_PATTERN.sub("", cleaned)

    # Normalize whitespace
    cleaned = re.sub(r"\s+", " ", cleaned).strip()

    return cleaned


def filter_example(example: dict, min_duration: float, max_duration: float) -> bool:
    """Filter out examples that are too short, too long, or have empty text."""
    duration = example.get("duration", 0)
    if duration and (duration < min_duration or duration > max_duration):
        return False

    text = example.get("raw_text", "")
    cleaned = clean_transcription(text)
    if len(cleaned) < 2:
        return False

    return True


def transform_example(example: dict) -> dict:
    """Transform an Omnilingual ASR example into Whisper training format.

    The output schema matches what the Whisper training pipeline expects:
    - audio: dict with 'array' and 'sampling_rate'
    - transcript: cleaned text
    - has_timestamps: False (this corpus doesn't have word-level timestamps)
    - has_prev: False (no previous context available)
    """
    return {
        "audio": example["audio"],
        "transcript": clean_transcription(example["raw_text"]),
        "has_timestamps": False,
        "has_prev": False,
        "prev_transcript": "",
    }


def load_yiddish_dataset(
    cache_dir: str = None,
    streaming: bool = False,
) -> DatasetDict:
    """Load the Yiddish subset from Meta's Omnilingual ASR Corpus.

    Args:
        cache_dir: Optional cache directory for downloaded data.
        streaming: If True, use streaming mode (useful for large datasets).

    Returns:
        DatasetDict with train/dev/test splits.
    """
    print("Loading Yiddish (ydd_Hebr) from facebook/omnilingual-asr-corpus...")

    dataset = load_dataset(
        "facebook/omnilingual-asr-corpus",
        "ydd_Hebr",
        cache_dir=cache_dir,
        streaming=streaming,
        trust_remote_code=True,
    )

    return dataset


def load_ivritai_yiddish_datasets(cache_dir: str = None) -> list:
    """Load ivrit.ai's Yiddish datasets for additional training data.

    These are crowd-sourced Yiddish recordings (~97 hours total):
    - crowd-recital-yi: ~78h of Wikipedia/Michlol article readings
    - crowd-whatsapp-yi: ~19h of WhatsApp voice recordings

    Returns:
        List of datasets with 'audio' and 'transcript' columns.
    """
    datasets_out = []

    for name, desc in [
        ("ivrit-ai/crowd-recital-yi-whisper-training", "Recital (~78h)"),
        ("ivrit-ai/crowd-whatsapp-yi-whisper-training", "WhatsApp (~19h)"),
    ]:
        print(f"Loading {desc}: {name}...")
        try:
            ds = load_dataset(name, split="train", cache_dir=cache_dir, trust_remote_code=True)
            print(f"  Loaded {len(ds)} examples")
            datasets_out.append(ds)
        except Exception as e:
            print(f"  Warning: Could not load {name}: {e}")
            print(f"  Skipping (these datasets may require HuggingFace authentication)")

    return datasets_out


def prepare_dataset(
    output_dir: str,
    cache_dir: str = None,
    min_duration: float = 0.5,
    max_duration: float = 30.0,
    eval_split_ratio: float = 0.1,
    max_eval_size: int = 500,
    seed: int = 42,
    num_proc: int = 4,
) -> None:
    """Download, clean, and prepare the Yiddish dataset for Whisper training.

    Args:
        output_dir: Directory to save the prepared dataset.
        cache_dir: Optional cache directory for downloads.
        min_duration: Minimum audio duration in seconds.
        max_duration: Maximum audio duration in seconds.
        eval_split_ratio: Fraction of train data to use for eval if no dev split.
        max_eval_size: Maximum number of eval examples.
        seed: Random seed for reproducibility.
        num_proc: Number of parallel processes for dataset operations.
    """
    os.makedirs(output_dir, exist_ok=True)

    # Load the dataset
    raw_dataset = load_yiddish_dataset(cache_dir=cache_dir)

    print(f"Raw dataset splits: {list(raw_dataset.keys())}")
    for split_name, split_data in raw_dataset.items():
        print(f"  {split_name}: {len(split_data)} examples")

    # Resample audio to 16kHz
    print(f"Resampling audio to {WHISPER_SAMPLE_RATE}Hz...")
    for split_name in raw_dataset:
        raw_dataset[split_name] = raw_dataset[split_name].cast_column(
            "audio", Audio(sampling_rate=WHISPER_SAMPLE_RATE)
        )

    # Filter examples
    print("Filtering examples by duration and transcription quality...")
    filtered = {}
    for split_name, split_data in raw_dataset.items():
        before = len(split_data)
        split_data = split_data.filter(
            lambda ex: filter_example(ex, min_duration, max_duration),
            num_proc=num_proc,
        )
        after = len(split_data)
        print(f"  {split_name}: {before} -> {after} examples ({before - after} removed)")
        filtered[split_name] = split_data

    # Transform to Whisper training format
    print("Transforming to Whisper training format...")
    transformed = {}
    for split_name, split_data in filtered.items():
        # Keep only the columns we need
        columns_to_remove = [
            c for c in split_data.column_names
            if c not in ("audio",)
        ]
        split_data = split_data.map(
            transform_example,
            remove_columns=columns_to_remove,
            num_proc=num_proc,
        )
        transformed[split_name] = split_data

    # Build train and eval sets
    if "train" in transformed:
        train_set = transformed["train"]
    else:
        raise ValueError("No 'train' split found in the dataset")

    # Use dev split for eval if available, otherwise split from train
    if "dev" in transformed:
        eval_set = transformed["dev"]
    elif "test" in transformed:
        eval_set = transformed["test"]
    else:
        print(f"No dev/test split found. Splitting {eval_split_ratio*100}% from train for eval...")
        split = train_set.train_test_split(test_size=eval_split_ratio, seed=seed)
        train_set = split["train"]
        eval_set = split["test"]

    # Cap eval set size
    if len(eval_set) > max_eval_size:
        eval_set = eval_set.shuffle(seed=seed).select(range(max_eval_size))

    print(f"\nFinal dataset sizes:")
    print(f"  Train: {len(train_set)} examples")
    print(f"  Eval:  {len(eval_set)} examples")

    # Save
    final_dataset = DatasetDict({"train": train_set, "eval": eval_set})
    save_path = os.path.join(output_dir, "yiddish-whisper-dataset")
    print(f"Saving prepared dataset to {save_path}...")
    final_dataset.save_to_disk(save_path)

    # Also save test set if it exists and is separate from eval
    if "test" in transformed and "dev" in transformed:
        test_path = os.path.join(output_dir, "yiddish-whisper-testset")
        print(f"Saving test set to {test_path}...")
        transformed["test"].save_to_disk(test_path)

    print("Done!")
    print(f"\nTo train, run:")
    print(f"  python train_whisper.py \\")
    print(f"    --use_preprocessed {save_path} \\")
    print(f"    --output_dir ./whisper-yiddish-finetuned")
    print(f"\nTip: For more Yiddish data, also consider ivrit.ai's datasets:")
    print(f"  - ivrit-ai/crowd-recital-yi-whisper-training (~78h)")
    print(f"  - ivrit-ai/crowd-whatsapp-yi-whisper-training (~19h)")
    print(f"  You can combine them using --include_ivritai_data")


def parse_args():
    parser = argparse.ArgumentParser(
        description="Prepare Yiddish data from Meta Omnilingual ASR Corpus for Whisper training"
    )
    parser.add_argument(
        "--output_dir", type=str, default="./data",
        help="Directory to save prepared dataset (default: ./data)"
    )
    parser.add_argument(
        "--cache_dir", type=str, default=None,
        help="Cache directory for HuggingFace downloads"
    )
    parser.add_argument(
        "--min_duration", type=float, default=0.5,
        help="Minimum audio duration in seconds (default: 0.5)"
    )
    parser.add_argument(
        "--max_duration", type=float, default=30.0,
        help="Maximum audio duration in seconds (default: 30.0)"
    )
    parser.add_argument(
        "--max_eval_size", type=int, default=500,
        help="Maximum eval set size (default: 500)"
    )
    parser.add_argument(
        "--num_proc", type=int, default=4,
        help="Number of parallel processes (default: 4)"
    )
    parser.add_argument(
        "--seed", type=int, default=42,
        help="Random seed (default: 42)"
    )
    parser.add_argument(
        "--include_ivritai_data", action="store_true",
        help="Also include ivrit.ai's Yiddish datasets (~97h extra data)"
    )
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    prepare_dataset(
        output_dir=args.output_dir,
        cache_dir=args.cache_dir,
        min_duration=args.min_duration,
        max_duration=args.max_duration,
        max_eval_size=args.max_eval_size,
        seed=args.seed,
        num_proc=args.num_proc,
    )

    # Optionally download ivrit.ai's Yiddish data alongside
    if args.include_ivritai_data:
        print("\n" + "=" * 60)
        print("Loading ivrit.ai Yiddish datasets...")
        print("=" * 60)
        ivritai_datasets = load_ivritai_yiddish_datasets(cache_dir=args.cache_dir)
        if ivritai_datasets:
            from datasets import concatenate_datasets as concat_ds
            combined = concat_ds(ivritai_datasets) if len(ivritai_datasets) > 1 else ivritai_datasets[0]
            ivritai_path = os.path.join(args.output_dir, "ivritai-yiddish-dataset")
            print(f"Saving ivrit.ai data to {ivritai_path}...")
            combined.save_to_disk(ivritai_path)
            print(f"Saved {len(combined)} examples from ivrit.ai")
            print(f"\nTo combine with Meta data during training, use:")
            print(f"  python train_whisper.py \\")
            print(f"    --train_datasets {os.path.join(args.output_dir, 'yiddish-whisper-dataset')}:train \\")
            print(f"                     {ivritai_path}:train \\")
            print(f"    --eval_datasets {os.path.join(args.output_dir, 'yiddish-whisper-dataset')}:eval")
