#!/usr/bin/env python3
"""
Fine-tune OpenAI Whisper for Yiddish ASR.

Pipeline modeled after ivrit-ai/asr-training with adaptations for Yiddish
using Meta's Omnilingual ASR Corpus (ydd_Hebr).

Key design decisions (from ivrit.ai's Yiddish Whisper training):
- Use timestamps + previous text conditioning to prevent catastrophic forgetting
- For Turbo: LR=5e-6 (half of Hebrew recipe); for Large: LR=1e-5
- Warmup: 500 steps, 4 epochs, batch size 32
- Two-phase: main training, then 200 steps post-training on conversational data at LR=1e-6
- Supports QLoRA for memory-constrained setups (single consumer GPU)
- Can also combine with ivrit.ai's existing Yiddish datasets for more data

Usage:
    # Step 1: Prepare dataset
    python prepare_dataset.py --output_dir ./data

    # Step 2: Train
    python train_whisper.py \
        --use_preprocessed ./data/yiddish-whisper-dataset \
        --output_dir ./whisper-yiddish-finetuned \
        --model_name openai/whisper-large-v3-turbo

    # Step 3: Export for inference
    python export_model.py \
        --model_dir ./whisper-yiddish-finetuned \
        --output_dir ./whisper-yiddish-ct2

References:
    - ivrit.ai blog: https://www.ivrit.ai/en/2025/02/13/training-whisper/
    - ivrit-ai/asr-training: https://github.com/ivrit-ai/asr-training
    - HF Whisper fine-tuning: https://huggingface.co/blog/fine-tune-whisper
"""

import argparse
import re
from functools import partial
from typing import Any, Dict, List, Union

import evaluate
import torch
from datasets import DatasetDict, load_dataset, load_from_disk
from transformers import (
    Seq2SeqTrainer,
    Seq2SeqTrainingArguments,
    WhisperForConditionalGeneration,
    WhisperProcessor,
)
from transformers.modeling_outputs import Seq2SeqLMOutput
from transformers.models.whisper.english_normalizer import BasicTextNormalizer

from preprocessor import (
    WHISPER_MAX_TARGET_POSITIONS,
    DataCollatorSpeechSeq2SeqWithPadding,
    DatasetPreparator,
    process_datasets,
)

# For splitting dataset spec strings like "dataset_name:train[0:1000]"
DATASET_SPEC_SPLIT = re.compile(r":(?=(?:[^\[\]]|\[[^\[\]]*\])*$)")


def load_datasets_from_specs(specs: list) -> list:
    """Load datasets from specification strings.

    Supports formats:
        - "dataset_name" (loads train split)
        - "dataset_name:split_name"
        - "/local/path" (loads from disk)
    """
    from datasets import ReadInstruction

    datasets = []
    for spec in specs:
        parts = re.split(DATASET_SPEC_SPLIT, spec)
        name = parts[0]
        split = parts[1] if len(parts) == 2 else "train"

        try:
            dataset = load_dataset(name, split=split)
        except Exception:
            dataset = load_from_disk(name)
            ri = ReadInstruction.from_spec(split)
            ri_data = ri._relative_instructions[0]
            split_name = ri_data.splitname
            dataset = dataset[split_name]
            from_entry = ri_data.from_
            to_entry = ri_data.to
            if from_entry is not None:
                dataset = dataset.skip(from_entry)
            else:
                from_entry = 0
            if to_entry is not None:
                dataset = dataset.take(to_entry - from_entry)

        datasets.append(dataset)

    return datasets


def compute_loss_func(
    outputs: Seq2SeqLMOutput,
    labels: torch.Tensor,
    num_items_in_batch: int,
) -> torch.Tensor:
    """Custom loss function with proper token-level averaging."""
    lm_logits = outputs.logits
    vocab_size = lm_logits.shape[2]
    reduction = "sum" if num_items_in_batch is not None else "mean"
    loss_fct = torch.nn.CrossEntropyLoss(reduction=reduction)
    labels = labels.to(lm_logits.device)
    loss = loss_fct(lm_logits.view(-1, vocab_size), labels.reshape(-1))
    if reduction == "sum":
        loss = loss / num_items_in_batch
    return loss


def compute_metrics(pred, processor, metric, normalizer):
    """Compute WER metrics (orthographic and normalized)."""
    pred_ids = pred.predictions
    label_ids = pred.label_ids

    label_ids[label_ids == -100] = processor.tokenizer.pad_token_id

    pred_str = processor.batch_decode(pred_ids, skip_special_tokens=True)
    label_str = processor.batch_decode(label_ids, skip_special_tokens=True)

    wer_ortho = metric.compute(predictions=pred_str, references=label_str)

    pred_str_norm = [normalizer(p) for p in pred_str]
    label_str_norm = [normalizer(l) for l in label_str]
    # Filter out empty references
    pairs = [(p, l) for p, l in zip(pred_str_norm, label_str_norm) if len(l) > 0]
    if pairs:
        pred_str_norm, label_str_norm = zip(*pairs)
        wer = metric.compute(predictions=list(pred_str_norm), references=list(label_str_norm))
    else:
        wer = 0.0

    return {"wer_ortho": wer_ortho, "wer": wer}


def setup_qlora(model):
    """Apply QLoRA configuration to the model for memory-efficient training."""
    from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training

    model = prepare_model_for_kbit_training(model)

    config = LoraConfig(
        r=64,
        lora_alpha=1,
        use_rslora=True,
        target_modules=["q_proj", "k_proj", "v_proj", "fc1", "fc2", "out_proj"],
        lora_dropout=0.05,
        bias="none",
    )

    model = get_peft_model(model, config)
    model.print_trainable_parameters()
    return model


def parse_args():
    parser = argparse.ArgumentParser(
        description="Fine-tune Whisper for Yiddish ASR"
    )

    # Data
    g = parser.add_argument_group("Data")
    g.add_argument("--use_preprocessed", type=str,
                   help="Path to preprocessed dataset (from prepare_dataset.py)")
    g.add_argument("--train_datasets", nargs="*",
                   help="Raw dataset specs for training (alternative to --use_preprocessed)")
    g.add_argument("--eval_datasets", nargs="*",
                   help="Raw dataset specs for evaluation")
    g.add_argument("--max_eval_set_size", type=int, default=500,
                   help="Max eval examples (default: 500)")

    # Model
    g = parser.add_argument_group("Model")
    g.add_argument("--model_name", type=str, default="openai/whisper-large-v3-turbo",
                   help="Base model (default: openai/whisper-large-v3-turbo)")
    g.add_argument("--target_language", type=str, default="yiddish",
                   help="Target language (default: yiddish)")
    g.add_argument("--use_qlora", action="store_true",
                   help="Use QLoRA for memory-efficient training")
    g.add_argument("--attn_implementation", default=None, choices=["sdpa"],
                   help="Attention implementation")

    # Training hyperparameters (defaults from ivrit.ai's Whisper Turbo training)
    g = parser.add_argument_group("Training")
    g.add_argument("--output_dir", type=str, required=True,
                   help="Output directory for checkpoints and final model")
    g.add_argument("--num_train_epochs", type=int, default=4,
                   help="Number of training epochs (default: 4, matching ivrit.ai Yiddish)")
    g.add_argument("--max_steps", type=int, default=-1,
                   help="Max training steps (overrides epochs)")
    g.add_argument("--learning_rate", type=float, default=5e-6,
                   help="Learning rate (default: 5e-6 for Turbo; use 1e-5 for Large)")
    g.add_argument("--lr_scheduler_type", type=str, default="linear",
                   help="LR scheduler (default: linear, matching ivrit.ai)")
    g.add_argument("--warmup_ratio", type=float, default=0.0,
                   help="Warmup ratio (default: 0, use warmup_steps instead)")
    g.add_argument("--warmup_steps", type=int, default=500,
                   help="Warmup steps (default: 500, matching ivrit.ai Yiddish)")
    g.add_argument("--per_device_train_batch_size", type=int, default=2,
                   help="Per-GPU batch size (default: 2, for 24GB VRAM)")
    g.add_argument("--per_device_eval_batch_size", type=int, default=4,
                   help="Per-GPU eval batch size (default: 4)")
    g.add_argument("--gradient_accumulation_steps", type=int, default=16,
                   help="Gradient accumulation (default: 16, effective batch=32)")
    g.add_argument("--weight_decay", type=float, default=0.05,
                   help="Weight decay (default: 0.05)")
    g.add_argument("--mixed_precision", choices=["bf16", "fp16", "tf32"],
                   default="bf16", help="Mixed precision mode (default: bf16)")

    # Preprocessing
    g = parser.add_argument_group("Preprocessing")
    g.add_argument("--include_timestamps_prob", type=float, default=0.5,
                   help="Probability of including timestamps (default: 0.5)")
    g.add_argument("--include_prev_text_prob", type=float, default=0.5,
                   help="Probability of including previous text (default: 0.5)")
    g.add_argument("--inject_synthetic_timestamps", action="store_true",
                   help="Inject synthetic start/end timestamps for non-timestamped data")
    g.add_argument("--audio_shift_augmentation", action="store_true",
                   help="Random audio shift augmentation")
    g.add_argument("--ds_processor_proc_num", type=int, default=1,
                   help="Parallel processes for dataset preprocessing")

    # Checkpointing
    g = parser.add_argument_group("Checkpointing")
    g.add_argument("--save_steps", type=int, default=500,
                   help="Save checkpoint every N steps")
    g.add_argument("--eval_steps", type=int, default=500,
                   help="Evaluate every N steps")
    g.add_argument("--logging_steps", type=int, default=100,
                   help="Log every N steps")
    g.add_argument("--max_checkpoints", type=int, default=3,
                   help="Max checkpoints to keep")
    g.add_argument("--resume_from_checkpoint", type=str, default=None,
                   help="Path to checkpoint to resume from (or 'latest')")

    # Hub / output
    g = parser.add_argument_group("Hub")
    g.add_argument("--push_to_hub", action="store_true",
                   help="Push final model to HuggingFace Hub")
    g.add_argument("--hub_model_id", type=str, default=None,
                   help="HuggingFace Hub model ID (e.g., 'your-org/whisper-yiddish')")
    g.add_argument("--run_name", type=str, default=None,
                   help="W&B / TensorBoard run name")

    return parser.parse_args()


def main():
    args = parse_args()

    print("=" * 60)
    print("Whisper Yiddish Fine-Tuning")
    print("=" * 60)
    print(f"Base model:     {args.model_name}")
    print(f"Language:       {args.target_language}")
    print(f"Output:         {args.output_dir}")
    print(f"Learning rate:  {args.learning_rate}")
    print(f"Batch size:     {args.per_device_train_batch_size} x {args.gradient_accumulation_steps} = "
          f"{args.per_device_train_batch_size * args.gradient_accumulation_steps}")
    print(f"Epochs:         {args.num_train_epochs}")
    print(f"QLoRA:          {args.use_qlora}")
    print("=" * 60)

    # Load processor
    processor = WhisperProcessor.from_pretrained(
        args.model_name,
        language=args.target_language,
        task="transcribe",
    )

    # Load or prepare dataset
    dataset_shuffle_seed = 745

    if args.use_preprocessed:
        print(f"Loading preprocessed dataset from {args.use_preprocessed}...")
        try:
            dataset_dict = load_from_disk(args.use_preprocessed)
        except FileNotFoundError:
            dataset_dict = load_dataset(args.use_preprocessed)

        train_set = dataset_dict["train"]
        eval_set = dataset_dict["eval"]

    elif args.train_datasets and args.eval_datasets:
        print("Loading and preprocessing raw datasets...")
        preparator = DatasetPreparator(
            processor,
            proc_num=args.ds_processor_proc_num,
            timestamp_sample_prob=args.include_timestamps_prob,
            condition_on_prev_sample_prob=args.include_prev_text_prob,
            inject_synthetic_timestamps=args.inject_synthetic_timestamps,
            audio_shift_augmentation=args.audio_shift_augmentation,
        )

        train_datasets = load_datasets_from_specs(args.train_datasets)
        eval_datasets = load_datasets_from_specs(args.eval_datasets)

        train_set = process_datasets(train_datasets, preparator)
        eval_set = process_datasets(eval_datasets, preparator)
    else:
        raise ValueError(
            "Provide either --use_preprocessed or both --train_datasets and --eval_datasets"
        )

    if args.max_eval_set_size and len(eval_set) > args.max_eval_set_size:
        eval_set = eval_set.shuffle(seed=dataset_shuffle_seed).select(range(args.max_eval_set_size))

    print(f"Train set: {len(train_set)} examples")
    print(f"Eval set:  {len(eval_set)} examples")

    # Data collator
    data_collator = DataCollatorSpeechSeq2SeqWithPadding(
        processor=processor,
        decoder_start_token_id=processor.tokenizer.convert_tokens_to_ids("<|startoftranscript|>"),
    )

    # Metrics
    metric = evaluate.load("wer")
    normalizer = BasicTextNormalizer()

    # Load model
    print(f"Loading model: {args.model_name}...")
    if args.use_qlora:
        from transformers import BitsAndBytesConfig
        model = WhisperForConditionalGeneration.from_pretrained(
            args.model_name,
            quantization_config=BitsAndBytesConfig(load_in_8bit=True),
        )
    else:
        model = WhisperForConditionalGeneration.from_pretrained(
            args.model_name,
            attn_implementation=args.attn_implementation,
        )

    # Configure for fine-tuning
    model.config.forced_decoder_ids = None
    model.config.suppress_tokens = []

    assert model.config.max_target_positions == WHISPER_MAX_TARGET_POSITIONS, (
        f"Model max_target_positions={model.config.max_target_positions} "
        f"!= expected {WHISPER_MAX_TARGET_POSITIONS}"
    )

    if args.use_qlora:
        model = setup_qlora(model)

    model.config.use_cache = False
    model.generate = partial(
        model.generate,
        language=args.target_language,
        task="transcribe",
        use_cache=True,
    )

    # Training arguments
    training_args = Seq2SeqTrainingArguments(
        output_dir=args.output_dir,
        per_device_train_batch_size=args.per_device_train_batch_size,
        per_device_eval_batch_size=args.per_device_eval_batch_size,
        gradient_accumulation_steps=args.gradient_accumulation_steps,
        learning_rate=args.learning_rate,
        lr_scheduler_type=args.lr_scheduler_type,
        warmup_ratio=args.warmup_ratio if args.warmup_steps == 0 else 0,
        warmup_steps=args.warmup_steps,
        num_train_epochs=args.num_train_epochs,
        max_steps=args.max_steps,
        weight_decay=args.weight_decay,
        eval_strategy="steps",
        eval_steps=args.eval_steps,
        save_strategy="steps",
        save_steps=args.save_steps,
        logging_strategy="steps",
        logging_steps=args.logging_steps,
        predict_with_generate=True,
        generation_max_length=WHISPER_MAX_TARGET_POSITIONS,
        load_best_model_at_end=False,
        metric_for_best_model="wer",
        greater_is_better=False,
        save_total_limit=args.max_checkpoints,
        push_to_hub=args.push_to_hub,
        hub_model_id=args.hub_model_id,
        report_to="all" if args.run_name else "none",
        run_name=args.run_name,
        remove_unused_columns=False,
        bf16=(args.mixed_precision == "bf16"),
        fp16=(args.mixed_precision == "fp16"),
        tf32=(args.mixed_precision == "tf32"),
        ddp_find_unused_parameters=False,
        average_tokens_across_devices=True,
        save_only_model=True,
    )

    # Trainer
    trainer = Seq2SeqTrainer(
        args=training_args,
        model=model,
        train_dataset=train_set,
        eval_dataset=eval_set,
        data_collator=data_collator,
        compute_metrics=lambda pred: compute_metrics(pred, processor, metric, normalizer),
        processing_class=processor,
        compute_loss_func=compute_loss_func,
    )

    # Resume from checkpoint
    resume = False
    if args.resume_from_checkpoint:
        if args.resume_from_checkpoint == "latest":
            resume = True
            print("Resuming from latest checkpoint...")
        else:
            resume = args.resume_from_checkpoint
            print(f"Resuming from checkpoint: {resume}")

    # Train
    print("\nStarting training!")
    trainer.train(resume_from_checkpoint=resume)

    # Save final model
    print(f"\nSaving final model to {args.output_dir}...")
    trainer.save_model(args.output_dir)
    processor.save_pretrained(args.output_dir)

    print("\nTraining complete!")
    print(f"Model saved to: {args.output_dir}")
    if args.push_to_hub:
        print(f"Model pushed to: {args.hub_model_id}")
    print(f"\nTo export for faster-whisper inference, run:")
    print(f"  python export_model.py --model_dir {args.output_dir} --output_dir ./whisper-yiddish-ct2")


if __name__ == "__main__":
    main()
