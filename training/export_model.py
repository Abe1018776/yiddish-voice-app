#!/usr/bin/env python3
"""
Export a fine-tuned Whisper model to CTranslate2 format for use with faster-whisper.

This converts the HuggingFace Transformers checkpoint to CTranslate2's optimized
format, which is what the RunPod inference worker expects.

Usage:
    python export_model.py \
        --model_dir ./whisper-yiddish-finetuned \
        --output_dir ./whisper-yiddish-ct2 \
        --quantization float16

    # For QLoRA models, merge adapter first:
    python export_model.py \
        --model_dir ./whisper-yiddish-finetuned \
        --base_model openai/whisper-large-v3-turbo \
        --merge_lora \
        --output_dir ./whisper-yiddish-ct2
"""

import argparse
import os
import shutil
import sys


def merge_lora_weights(model_dir: str, base_model: str, output_dir: str) -> str:
    """Merge LoRA adapter weights into the base model."""
    from peft import PeftModel
    from transformers import WhisperForConditionalGeneration

    print(f"Loading base model: {base_model}...")
    model = WhisperForConditionalGeneration.from_pretrained(base_model)

    print(f"Loading LoRA adapter from: {model_dir}...")
    model = PeftModel.from_pretrained(model, model_dir)

    print("Merging LoRA weights...")
    model = model.merge_and_unload()

    merged_dir = os.path.join(output_dir, "_merged_hf")
    os.makedirs(merged_dir, exist_ok=True)
    print(f"Saving merged model to: {merged_dir}...")
    model.save_pretrained(merged_dir)

    # Copy tokenizer files
    from transformers import WhisperProcessor
    processor = WhisperProcessor.from_pretrained(model_dir)
    processor.save_pretrained(merged_dir)

    return merged_dir


def export_to_ct2(model_dir: str, output_dir: str, quantization: str = "float16") -> None:
    """Convert a HuggingFace Whisper model to CTranslate2 format."""
    import ctranslate2

    print(f"Converting to CTranslate2 (quantization={quantization})...")
    converter = ctranslate2.converters.TransformersConverter(
        model_name_or_path=model_dir,
    )
    converter.convert(
        output_dir=output_dir,
        quantization=quantization,
        force=True,
    )

    # Copy tokenizer files needed by faster-whisper
    tokenizer_files = [
        "tokenizer.json",
        "tokenizer_config.json",
        "special_tokens_map.json",
        "added_tokens.json",
        "vocab.json",
        "merges.txt",
        "normalizer.json",
        "preprocessor_config.json",
    ]

    for fname in tokenizer_files:
        src = os.path.join(model_dir, fname)
        if os.path.exists(src):
            shutil.copy2(src, output_dir)
            print(f"  Copied {fname}")

    print(f"\nCTranslate2 model saved to: {output_dir}")


def export_to_ggml(model_dir: str, output_dir: str) -> None:
    """Convert to GGML format (for whisper.cpp)."""
    print("GGML export requires whisper.cpp's convert script.")
    print("See: https://github.com/ggerganov/whisper.cpp/blob/master/models/convert-h5-to-ggml.py")
    print(f"  python convert-h5-to-ggml.py {model_dir} {output_dir}")


def parse_args():
    parser = argparse.ArgumentParser(
        description="Export fine-tuned Whisper model for inference"
    )
    parser.add_argument("--model_dir", type=str, required=True,
                        help="Path to the fine-tuned HuggingFace model")
    parser.add_argument("--output_dir", type=str, required=True,
                        help="Output directory for the exported model")
    parser.add_argument("--quantization", type=str, default="float16",
                        choices=["float16", "float32", "int8", "int8_float16", "int8_float32"],
                        help="Quantization type for CTranslate2 (default: float16)")
    parser.add_argument("--format", type=str, default="ct2",
                        choices=["ct2", "ggml"],
                        help="Export format (default: ct2 for faster-whisper)")
    parser.add_argument("--merge_lora", action="store_true",
                        help="Merge LoRA adapter weights before export")
    parser.add_argument("--base_model", type=str, default="openai/whisper-large-v3-turbo",
                        help="Base model for LoRA merging (default: openai/whisper-large-v3-turbo)")
    return parser.parse_args()


def main():
    args = parse_args()

    os.makedirs(args.output_dir, exist_ok=True)

    model_dir = args.model_dir

    # Merge LoRA if needed
    if args.merge_lora:
        model_dir = merge_lora_weights(model_dir, args.base_model, args.output_dir)

    # Export
    if args.format == "ct2":
        export_to_ct2(model_dir, args.output_dir, args.quantization)
    elif args.format == "ggml":
        export_to_ggml(model_dir, args.output_dir)

    # Clean up merged model if we created one
    if args.merge_lora:
        merged_dir = os.path.join(args.output_dir, "_merged_hf")
        if os.path.exists(merged_dir):
            print(f"Cleaning up temporary merged model at {merged_dir}...")
            shutil.rmtree(merged_dir)

    print("\nDone! The exported model can be used with faster-whisper:")
    print(f'  from faster_whisper import WhisperModel')
    print(f'  model = WhisperModel("{args.output_dir}", device="cuda", compute_type="float16")')
    print(f'  segments, info = model.transcribe("audio.wav", language="yi")')


if __name__ == "__main__":
    main()
