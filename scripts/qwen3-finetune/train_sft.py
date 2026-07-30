#!/usr/bin/env python3
"""Windows/SDPA single-speaker SFT wrapper for the pinned Qwen3-TTS code."""

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
from accelerate import Accelerator
from qwen_tts.inference.qwen3_tts_model import Qwen3TTSModel
from safetensors.torch import save_file
from torch.optim import AdamW
from torch.utils.data import DataLoader
from transformers import AutoConfig


HERE = Path(__file__).resolve().parent
WORK = HERE / "work"
OFFICIAL_COMMIT = "022e286b98fbec7e1e916cb940cdf532cd9f488e"
SPEAKER_ID = 3000


def _load_dataset_class(official_source: Path):
    commit = subprocess.check_output(
        ["git", "-C", str(official_source), "rev-parse", "HEAD"], text=True
    ).strip()
    if commit != OFFICIAL_COMMIT:
        raise SystemExit(f"official source commit mismatch: {commit}")
    finetuning = official_source / "finetuning"
    sys.path.insert(0, str(finetuning))
    from dataset import TTSDataset

    return TTSDataset


def _save_inference_checkpoint(
    accelerator: Accelerator,
    model,
    model_path: Path,
    output_root: Path,
    epoch: int,
    speaker_name: str,
    speaker_embedding: torch.Tensor,
) -> None:
    accelerator.wait_for_everyone()
    if not accelerator.is_main_process:
        return
    output_dir = output_root / f"checkpoint-epoch-{epoch}"
    shutil.copytree(model_path, output_dir, dirs_exist_ok=True)
    config_path = output_dir / "config.json"
    config_dict = json.loads(config_path.read_text(encoding="utf-8"))
    config_dict["tts_model_type"] = "custom_voice"
    talker_config = config_dict.setdefault("talker_config", {})
    talker_config["spk_id"] = {speaker_name: SPEAKER_ID}
    talker_config["spk_is_dialect"] = {speaker_name: False}
    config_path.write_text(
        json.dumps(config_dict, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )

    state_dict = {
        key: value.detach().cpu()
        for key, value in accelerator.get_state_dict(model).items()
        if not key.startswith("speaker_encoder")
    }
    weight = state_dict["talker.model.codec_embedding.weight"]
    weight[SPEAKER_ID] = speaker_embedding[0].detach().to(weight.dtype).cpu()
    weights_path = output_dir / "model.safetensors"
    weights_path.unlink(missing_ok=True)
    save_file(state_dict, weights_path)
    (output_dir / "kxyy-finetune.json").write_text(
        json.dumps(
            {
                "official_commit": OFFICIAL_COMMIT,
                "speaker_name": speaker_name,
                "speaker_id": SPEAKER_ID,
                "epoch": epoch,
                "attention": "sdpa",
                "dtype": "bfloat16",
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--official-source", type=Path, default=WORK / "Qwen3-TTS")
    parser.add_argument("--init-model-path", type=Path, required=True)
    parser.add_argument("--train-jsonl", type=Path, default=WORK / "train_with_codes.jsonl")
    parser.add_argument("--output-model-path", type=Path, default=HERE / "output")
    parser.add_argument("--batch-size", type=int, default=1)
    parser.add_argument("--gradient-accumulation-steps", type=int, default=4)
    parser.add_argument("--lr", type=float, default=2e-5)
    parser.add_argument("--num-epochs", type=int, default=3)
    parser.add_argument("--speaker-name", default="yuanyuan")
    parser.add_argument("--max-micro-steps", type=int)
    parser.add_argument("--smoke-longest", action="store_true")
    parser.add_argument("--save-every-micro-steps", type=int, default=64)
    parser.add_argument("--gradient-checkpointing", action="store_true", default=True)
    parser.add_argument("--seed", type=int, default=20260730)
    args = parser.parse_args()

    if args.batch_size != 1:
        raise SystemExit("batch-size is locked to 1 for the RTX 5080 16GB host")
    if args.gradient_accumulation_steps < 4:
        raise SystemExit("gradient accumulation must be at least 4")
    if not 1 <= args.num_epochs <= 3:
        raise SystemExit("num-epochs must be in [1, 3]")
    if not args.init_model_path.is_dir():
        raise SystemExit("init-model-path must be a downloaded local model directory")
    if args.max_micro_steps is not None and args.max_micro_steps < 1:
        raise SystemExit("max-micro-steps must be positive")

    TTSDataset = _load_dataset_class(args.official_source)
    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)
    torch.cuda.manual_seed_all(args.seed)
    accelerator = Accelerator(
        gradient_accumulation_steps=args.gradient_accumulation_steps,
        mixed_precision="bf16",
    )
    qwen3tts = Qwen3TTSModel.from_pretrained(
        str(args.init_model_path),
        torch_dtype=torch.bfloat16,
        attn_implementation="sdpa",
    )
    if args.gradient_checkpointing:
        qwen3tts.model.gradient_checkpointing_enable()
        qwen3tts.model.config.use_cache = False
    config = AutoConfig.from_pretrained(str(args.init_model_path))
    train_data = [
        json.loads(line)
        for line in args.train_jsonl.read_text(encoding="utf-8").splitlines()
        if line
    ]
    if args.smoke_longest:
        if args.max_micro_steps != 1:
            raise SystemExit("--smoke-longest requires --max-micro-steps 1")
        train_data = [max(train_data, key=lambda row: len(row["audio_codes"]))]
    dataset = TTSDataset(train_data, qwen3tts.processor, config)
    generator = torch.Generator().manual_seed(args.seed)
    dataloader = DataLoader(
        dataset,
        batch_size=1,
        shuffle=not args.smoke_longest,
        collate_fn=dataset.collate_fn,
        num_workers=0,
        generator=generator,
    )
    optimizer = AdamW(qwen3tts.model.parameters(), lr=args.lr, weight_decay=0.01)
    model, optimizer, dataloader = accelerator.prepare(
        qwen3tts.model, optimizer, dataloader
    )
    model.train()
    speaker_embedding = None
    micro_steps = 0
    stop = False
    torch.cuda.reset_peak_memory_stats()

    for epoch in range(args.num_epochs):
        for step, batch in enumerate(dataloader):
            with accelerator.accumulate(model):
                input_ids = batch["input_ids"]
                codec_ids = batch["codec_ids"]
                ref_mels = batch["ref_mels"]
                text_embedding_mask = batch["text_embedding_mask"]
                codec_embedding_mask = batch["codec_embedding_mask"]
                attention_mask = batch["attention_mask"]
                codec_0_labels = batch["codec_0_labels"]
                codec_mask = batch["codec_mask"]

                current_embedding = model.speaker_encoder(
                    ref_mels.to(model.device).to(model.dtype)
                ).detach()
                if speaker_embedding is None:
                    speaker_embedding = current_embedding
                input_text_ids = input_ids[:, :, 0]
                input_codec_ids = input_ids[:, :, 1]
                input_embeddings = model.talker.text_projection(
                    model.talker.model.text_embedding(input_text_ids)
                ) * text_embedding_mask
                input_embeddings += (
                    model.talker.model.codec_embedding(input_codec_ids)
                    * codec_embedding_mask
                )
                input_embeddings[:, 6, :] = current_embedding
                for index in range(1, 16):
                    codec_embedding = model.talker.code_predictor.get_input_embeddings()[
                        index - 1
                    ](codec_ids[:, :, index])
                    input_embeddings += codec_embedding * codec_mask.unsqueeze(-1)

                outputs = model.talker(
                    inputs_embeds=input_embeddings[:, :-1, :],
                    attention_mask=attention_mask[:, :-1],
                    labels=codec_0_labels[:, 1:],
                    output_hidden_states=True,
                )
                hidden_states = outputs.hidden_states[0][-1]
                talker_hidden_states = hidden_states[codec_mask[:, :-1]]
                talker_codec_ids = codec_ids[codec_mask]
                _, sub_talker_loss = model.talker.forward_sub_talker_finetune(
                    talker_codec_ids, talker_hidden_states
                )
                loss = outputs.loss + 0.3 * sub_talker_loss
                accelerator.backward(loss)
                if accelerator.sync_gradients:
                    accelerator.clip_grad_norm_(model.parameters(), 1.0)
                optimizer.step()
                optimizer.zero_grad()

            micro_steps += 1
            if step % 10 == 0:
                accelerator.print(
                    f"epoch={epoch} step={step} micro_steps={micro_steps} loss={loss.item():.4f}"
                )
            if (
                args.save_every_micro_steps > 0
                and micro_steps % args.save_every_micro_steps == 0
                and speaker_embedding is not None
            ):
                _save_inference_checkpoint(
                    accelerator,
                    model,
                    args.init_model_path,
                    args.output_model_path / "intermediate",
                    micro_steps,
                    args.speaker_name,
                    speaker_embedding,
                )
            if args.max_micro_steps is not None and micro_steps >= args.max_micro_steps:
                stop = True
                break

        peak_gib = torch.cuda.max_memory_allocated() / (1024**3)
        accelerator.print(f"epoch={epoch} peak_allocated_gib={peak_gib:.3f}")
        if stop:
            break
        assert speaker_embedding is not None
        _save_inference_checkpoint(
            accelerator,
            model,
            args.init_model_path,
            args.output_model_path,
            epoch,
            args.speaker_name,
            speaker_embedding,
        )

    accelerator.wait_for_everyone()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
