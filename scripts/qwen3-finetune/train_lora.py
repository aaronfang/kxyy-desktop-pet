#!/usr/bin/env python3
"""Single-GPU LoRA SFT for a merged Qwen3-TTS custom-voice checkpoint."""

from __future__ import annotations

import argparse
import json
import random
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
import torch
from peft import LoraConfig, get_peft_model
from qwen_tts.inference.qwen3_tts_model import Qwen3TTSModel
from safetensors.torch import save_file
from torch.optim import AdamW
from torch.utils.data import DataLoader
from transformers import AutoConfig


HERE = Path(__file__).resolve().parent
WORK = HERE / "work"
OFFICIAL_COMMIT = "022e286b98fbec7e1e916cb940cdf532cd9f488e"
SPEAKER_ID = 3000
TARGET_MODULES = (
    r"talker\.model\.layers\.\d+\.self_attn\.(?:q_proj|k_proj|v_proj|o_proj)"
)


def _load_dataset_class(official_source: Path):
    commit = subprocess.check_output(
        ["git", "-C", str(official_source), "rev-parse", "HEAD"], text=True
    ).strip()
    if commit != OFFICIAL_COMMIT:
        raise SystemExit(f"official source commit mismatch: {commit}")
    sys.path.insert(0, str(official_source / "finetuning"))
    from dataset import TTSDataset

    return TTSDataset


def _save_merged_checkpoint(
    qwen3tts: Qwen3TTSModel,
    model_path: Path,
    output_dir: Path,
    speaker_name: str,
    speaker_embedding: torch.Tensor,
    metadata: dict,
) -> None:
    merged = qwen3tts.model.merge_and_unload(safe_merge=True)
    shutil.copytree(model_path, output_dir, dirs_exist_ok=True)
    config_path = output_dir / "config.json"
    config = json.loads(config_path.read_text(encoding="utf-8"))
    config["tts_model_type"] = "custom_voice"
    talker = config.setdefault("talker_config", {})
    talker["spk_id"] = {speaker_name: SPEAKER_ID}
    talker["spk_is_dialect"] = {speaker_name: False}
    config_path.write_text(
        json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    state_dict = {
        key: value.detach().cpu().contiguous()
        for key, value in merged.state_dict().items()
        if not key.startswith("speaker_encoder")
    }
    weight = state_dict["talker.model.codec_embedding.weight"]
    weight[SPEAKER_ID] = speaker_embedding.to(weight.dtype).cpu()
    weights_path = output_dir / "model.safetensors"
    weights_path.unlink(missing_ok=True)
    save_file(state_dict, weights_path)
    (output_dir / "kxyy-finetune.json").write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--official-source", type=Path, default=WORK / "Qwen3-TTS")
    parser.add_argument("--init-model-path", type=Path, required=True)
    parser.add_argument("--train-jsonl", type=Path, default=WORK / "train_with_codes.jsonl")
    parser.add_argument("--output-model-path", type=Path, default=HERE / "output-lora17")
    parser.add_argument("--gradient-accumulation-steps", type=int, default=4)
    parser.add_argument("--lr", type=float, default=1e-4)
    parser.add_argument("--num-epochs", type=int, default=1)
    parser.add_argument("--max-micro-steps", type=int)
    parser.add_argument("--smoke-longest", action="store_true")
    parser.add_argument("--speaker-name", default="yuanyuan")
    parser.add_argument("--lora-rank", type=int, default=16)
    parser.add_argument("--lora-alpha", type=int, default=32)
    parser.add_argument("--seed", type=int, default=20260731)
    args = parser.parse_args()

    if not args.init_model_path.is_dir():
        raise SystemExit("init-model-path must be a downloaded local model directory")
    if args.gradient_accumulation_steps < 1:
        raise SystemExit("gradient accumulation must be positive")
    if not 1 <= args.num_epochs <= 3:
        raise SystemExit("num-epochs must be in [1, 3]")
    if args.max_micro_steps is not None and args.max_micro_steps < 1:
        raise SystemExit("max-micro-steps must be positive")
    if args.smoke_longest and args.max_micro_steps != 1:
        raise SystemExit("--smoke-longest requires --max-micro-steps 1")
    if args.lora_rank not in (4, 8, 16, 32, 64):
        raise SystemExit("lora-rank must be one of 4, 8, 16, 32, 64")

    TTSDataset = _load_dataset_class(args.official_source)
    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)
    torch.cuda.manual_seed_all(args.seed)
    device = torch.device("cuda:0")
    qwen3tts = Qwen3TTSModel.from_pretrained(
        str(args.init_model_path),
        dtype=torch.bfloat16,
        device_map="cuda:0",
        attn_implementation="sdpa",
    )
    qwen3tts.model = get_peft_model(
        qwen3tts.model,
        LoraConfig(
            r=args.lora_rank,
            lora_alpha=args.lora_alpha,
            lora_dropout=0.0,
            bias="none",
            target_modules=TARGET_MODULES,
        ),
    )
    qwen3tts.model.base_model.model.gradient_checkpointing_enable()
    qwen3tts.model.base_model.model.config.use_cache = False
    trainable = [name for name, value in qwen3tts.model.named_parameters() if value.requires_grad]
    if not trainable or any("code_predictor" in name for name in trainable):
        raise RuntimeError("LoRA target selection escaped the main talker")
    trainable_count = sum(
        value.numel() for value in qwen3tts.model.parameters() if value.requires_grad
    )
    total_count = sum(value.numel() for value in qwen3tts.model.parameters())
    print(
        f"trainable={trainable_count} total={total_count} "
        f"ratio={trainable_count / total_count:.6f}",
        flush=True,
    )

    config = AutoConfig.from_pretrained(str(args.init_model_path))
    train_data = [
        json.loads(line)
        for line in args.train_jsonl.read_text(encoding="utf-8").splitlines()
        if line
    ]
    if args.smoke_longest:
        train_data = [max(train_data, key=lambda row: len(row["audio_codes"]))]
    dataset = TTSDataset(train_data, qwen3tts.processor, config)
    dataloader = DataLoader(
        dataset,
        batch_size=1,
        shuffle=not args.smoke_longest,
        collate_fn=dataset.collate_fn,
        num_workers=0,
        generator=torch.Generator().manual_seed(args.seed),
    )
    optimizer = AdamW(
        (value for value in qwen3tts.model.parameters() if value.requires_grad),
        lr=args.lr,
        weight_decay=0.01,
    )
    model = qwen3tts.model
    model.train()
    optimizer.zero_grad(set_to_none=True)
    speaker_sum = None
    speaker_count = 0
    micro_steps = 0
    optimizer_steps = 0
    stop = False
    torch.cuda.reset_peak_memory_stats()

    for epoch in range(args.num_epochs):
        for batch_index, batch in enumerate(dataloader):
            batch = {
                key: value.to(device) if isinstance(value, torch.Tensor) else value
                for key, value in batch.items()
            }
            input_ids = batch["input_ids"]
            codec_ids = batch["codec_ids"]
            ref_mels = batch["ref_mels"]
            text_embedding_mask = batch["text_embedding_mask"]
            codec_embedding_mask = batch["codec_embedding_mask"]
            attention_mask = batch["attention_mask"]
            codec_0_labels = batch["codec_0_labels"]
            codec_mask = batch["codec_mask"]

            with torch.no_grad():
                base = model.base_model.model
                current_embedding = base.speaker_encoder(
                    ref_mels.to(device=device, dtype=torch.bfloat16)
                ).detach()
                current_cpu = current_embedding[0].float().cpu()
                speaker_sum = current_cpu if speaker_sum is None else speaker_sum + current_cpu
                speaker_count += 1
                input_text_ids = input_ids[:, :, 0]
                input_codec_ids = input_ids[:, :, 1]
                input_embeddings = base.talker.text_projection(
                    base.talker.model.text_embedding(input_text_ids)
                ) * text_embedding_mask
                input_embeddings += (
                    base.talker.model.codec_embedding(input_codec_ids)
                    * codec_embedding_mask
                )
                input_embeddings[:, 6, :] = current_embedding
                for index in range(1, 16):
                    codec_embedding = base.talker.code_predictor.get_input_embeddings()[
                        index - 1
                    ](codec_ids[:, :, index])
                    input_embeddings += codec_embedding * codec_mask.unsqueeze(-1)
            # Checkpointed frozen layers need one differentiable entry tensor so the
            # recompute pass can retain gradients for the LoRA projections.
            input_embeddings.requires_grad_(True)

            outputs = base.talker(
                inputs_embeds=input_embeddings[:, :-1, :],
                attention_mask=attention_mask[:, :-1],
                labels=codec_0_labels[:, 1:],
                output_hidden_states=True,
            )
            hidden_states = outputs.hidden_states[0][-1]
            talker_hidden_states = hidden_states[codec_mask[:, :-1]]
            talker_codec_ids = codec_ids[codec_mask]
            _, sub_talker_loss = base.talker.forward_sub_talker_finetune(
                talker_codec_ids, talker_hidden_states
            )
            loss = outputs.loss + 0.3 * sub_talker_loss
            (loss / args.gradient_accumulation_steps).backward()
            micro_steps += 1
            should_step = (
                micro_steps % args.gradient_accumulation_steps == 0
                or micro_steps == args.max_micro_steps
                or batch_index + 1 == len(dataloader)
            )
            if should_step:
                torch.nn.utils.clip_grad_norm_(
                    (value for value in model.parameters() if value.requires_grad), 1.0
                )
                optimizer.step()
                optimizer.zero_grad(set_to_none=True)
                optimizer_steps += 1
            if micro_steps == 1 or micro_steps % 10 == 0:
                print(
                    f"epoch={epoch} micro_steps={micro_steps} "
                    f"optimizer_steps={optimizer_steps} loss={loss.item():.4f}",
                    flush=True,
                )
            if args.max_micro_steps is not None and micro_steps >= args.max_micro_steps:
                stop = True
                break
        if stop:
            break

    peak_gib = torch.cuda.max_memory_allocated() / (1024**3)
    print(f"peak_allocated_gib={peak_gib:.3f}", flush=True)
    if speaker_sum is None or speaker_count < 1:
        raise RuntimeError("training produced no speaker embedding")
    _save_merged_checkpoint(
        qwen3tts,
        args.init_model_path,
        args.output_model_path,
        args.speaker_name,
        speaker_sum / speaker_count,
        {
            "schema_version": 1,
            "method": "lora-merged",
            "official_commit": OFFICIAL_COMMIT,
            "base_model": args.init_model_path.name,
            "speaker_name": args.speaker_name,
            "speaker_id": SPEAKER_ID,
            "speaker_embedding_samples": speaker_count,
            "lora_rank": args.lora_rank,
            "lora_alpha": args.lora_alpha,
            "target_modules": TARGET_MODULES,
            "learning_rate": args.lr,
            "micro_steps": micro_steps,
            "optimizer_steps": optimizer_steps,
            "seed": args.seed,
            "peak_allocated_gib": round(peak_gib, 3),
            "peft_version": "0.20.0",
        },
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
