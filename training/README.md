# Whisper Yiddish Training Pipeline

Fine-tune OpenAI's Whisper model for Yiddish ASR using Meta's Omnilingual ASR Corpus.

## Approach

This pipeline follows [ivrit.ai's methodology](https://www.ivrit.ai/en/2025/02/13/training-whisper/) for fine-tuning Whisper, adapted for Yiddish:

- **Base model**: `openai/whisper-large-v3-turbo`
- **Dataset**: [facebook/omnilingual-asr-corpus](https://huggingface.co/datasets/facebook/omnilingual-asr-corpus) (Yiddish subset: `ydd_Hebr`)
- **Key insight**: Include timestamps and previous text conditioning to prevent catastrophic forgetting
- **Training recipe**: LR=1e-5, batch=2×16 gradient accumulation, ~2-3 epochs, linear warmup 10%

## Quick Start

### 1. Install dependencies

```bash
pip install -r requirements.txt
```

### 2. Prepare dataset

Downloads the Yiddish subset from Meta's Omnilingual ASR Corpus and prepares it for training:

```bash
python prepare_dataset.py --output_dir ./data --num_proc 4
```

### 3. Train

```bash
# Full fine-tuning (requires ~24GB+ VRAM, e.g., RTX 4090 / A100)
python train_whisper.py \
    --use_preprocessed ./data/yiddish-whisper-dataset \
    --output_dir ./whisper-yiddish-finetuned \
    --model_name openai/whisper-large-v3-turbo \
    --num_train_epochs 3 \
    --learning_rate 1e-5 \
    --per_device_train_batch_size 2 \
    --gradient_accumulation_steps 16 \
    --mixed_precision bf16 \
    --inject_synthetic_timestamps \
    --run_name whisper-yiddish-v1

# QLoRA (for GPUs with less VRAM, e.g., RTX 3090)
python train_whisper.py \
    --use_preprocessed ./data/yiddish-whisper-dataset \
    --output_dir ./whisper-yiddish-qlora \
    --model_name openai/whisper-large-v3-turbo \
    --use_qlora \
    --num_train_epochs 3 \
    --learning_rate 1e-5 \
    --per_device_train_batch_size 4 \
    --gradient_accumulation_steps 8 \
    --mixed_precision bf16
```

### 4. Export for inference

Convert the fine-tuned model to CTranslate2 format (used by faster-whisper in the RunPod worker):

```bash
# Standard export
python export_model.py \
    --model_dir ./whisper-yiddish-finetuned \
    --output_dir ./whisper-yiddish-ct2 \
    --quantization float16

# For QLoRA models (merges adapter weights first)
python export_model.py \
    --model_dir ./whisper-yiddish-qlora \
    --output_dir ./whisper-yiddish-ct2 \
    --merge_lora \
    --base_model openai/whisper-large-v3-turbo
```

### 5. Deploy

Copy the exported model to the RunPod worker's model path:

```bash
# Upload to your model storage (RunPod network volume, S3, etc.)
# The whisper worker expects models at /models/whisper-yiddish
```

## Pipeline Architecture

```
facebook/omnilingual-asr-corpus (ydd_Hebr)
    │
    ▼
prepare_dataset.py    ← Download, clean, filter, format
    │
    ▼
train_whisper.py      ← Fine-tune with Seq2SeqTrainer
    │                    (timestamps + prev text conditioning)
    ▼
export_model.py       ← Convert to CTranslate2 / GGML
    │
    ▼
runpod-workers/whisper/handler.py  ← Inference via faster-whisper
```

## Training Details

### Hyperparameters (defaults match ivrit.ai's Yiddish recipe)

| Parameter | Turbo (default) | Large v3 | Notes |
|-----------|-----------------|----------|-------|
| Base model | whisper-large-v3-turbo | whisper-large-v3 | |
| Learning rate | 5e-6 | 1e-5 | Turbo needs lower LR |
| Warmup steps | 500 | 500 | |
| LR schedule | Linear decay | Linear decay | |
| Batch size | 2 per GPU | 2 per GPU | With 16x grad accum |
| Effective batch | 32 | 32 | |
| Epochs | 4 | 4 | ivrit.ai used 4 for Yiddish |
| Weight decay | 0.05 | 0.05 | |
| Mixed precision | bf16 | bf16 | |
| Post-training | 200 steps @ 1e-6 | 200 steps @ 1e-6 | On conversational data |

### Preventing Catastrophic Forgetting

The key challenge in fine-tuning Whisper (especially the Turbo variant) is catastrophic forgetting. Without proper training data formatting, the model can lose its ability to handle timestamps and long-form transcription. Following ivrit.ai's approach:

1. **Synthetic timestamps**: Inject start/end timestamp tokens even for non-timestamped data
2. **Previous text conditioning**: Include previous text context to maintain long-form behavior
3. **Short training**: Stop at ~2 epochs before the model starts degrading

## Data Sources

### Meta Omnilingual ASR Corpus
A collection of spontaneous speech recordings for 348+ under-served languages. The Yiddish subset (`ydd_Hebr`) contains train/dev/test splits with FLAC audio + Hebrew-script transcriptions. CC-BY-4.0 license.

### ivrit.ai Yiddish Datasets (optional, ~97h extra)
ivrit.ai has released crowd-sourced Yiddish recordings:
- `ivrit-ai/crowd-recital-yi-whisper-training` (~78h) — Wikipedia/Michlol article readings
- `ivrit-ai/crowd-whatsapp-yi-whisper-training` (~19h) — WhatsApp voice recordings

Use `--include_ivritai_data` with `prepare_dataset.py` to download these alongside the Meta corpus.

### Existing ivrit.ai Yiddish Models
ivrit.ai already released fine-tuned Yiddish Whisper models that can serve as starting points:
- `ivrit-ai/yi-whisper-large-v3-turbo` (0.8B params)
- `ivrit-ai/yi-whisper-large-v3` (2B params)

You could use these as `--model_name` instead of the base OpenAI model for further fine-tuning.

## References

- [ivrit.ai: Training Whisper Turbo](https://www.ivrit.ai/en/2025/02/13/training-whisper/)
- [ivrit-ai/asr-training](https://github.com/ivrit-ai/asr-training)
- [ivrit-ai/yi-whisper-large-v3-turbo](https://huggingface.co/ivrit-ai/yi-whisper-large-v3-turbo)
- [HuggingFace: Fine-Tune Whisper](https://huggingface.co/blog/fine-tune-whisper)
- [Meta Omnilingual ASR Paper](https://arxiv.org/abs/2511.09690)
- [facebook/omnilingual-asr-corpus](https://huggingface.co/datasets/facebook/omnilingual-asr-corpus)
- [ivrit.ai arXiv paper](https://arxiv.org/abs/2307.08720)
