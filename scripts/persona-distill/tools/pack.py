#!/usr/bin/env python3
"""一键蒸馏 + 打包人格卡工具。

用法:
  # 完整流程：扫描目录 → 蒸馏 → 校验 → 打包
  python tools/pack.py --input sample_wav/ --name kxyy-yuanyuan

  # 仅打包已有蒸馏产物（跳过蒸馏步骤）
  python tools/pack.py --input sample_wav/ --name kxyy-yuanyuan --skip-distill

  # 从已有 persona_profile.json 打包
  python tools/pack.py --from-profile output/compile/persona_profile.json --name my-character

  # 断点续跑：跳过已完成步骤
  python tools/pack.py --input sample_wav/ --name kxyy-yuanyuan --resume

  # 仅校验（不运行任何步骤）
  python tools/pack.py --validate-only persona-cards/kxyy-yuanyuan/persona-card.json

设计目标:
  - 可独立使用，不依赖项目的 Tauri 构建系统
  - 支持断点续跑（通过 .step_*.json 状态文件）
  - 未来可抽成独立仓库
"""

import argparse
import json
import subprocess
import sys
import shutil
from datetime import date
from pathlib import Path


# ---------------------------------------------------------------------------
# 路径常量
# ---------------------------------------------------------------------------
PIPELINE_DIR = Path(__file__).resolve().parent.parent
PIPELINE_SCRIPT = PIPELINE_DIR / "pipeline.py"
SCHEMA_DIR = PIPELINE_DIR / "schema"
TOOLS_DIR = PIPELINE_DIR / "tools"
OUTPUT_DIR = PIPELINE_DIR / "output"
PROJECT_ROOT = PIPELINE_DIR.parent.parent
PERSONA_CARDS_DIR = PROJECT_ROOT / "persona-cards"

# 步骤定义：名称 → pipeline 子命令
PIPELINE_STEPS = [
    ("denoise", "denoise"),
    ("extract_anchor", "extract-anchor"),
    ("transcribe", "transcribe"),
    ("clean", "clean"),
    ("distill", "distill"),
    ("compile", "compile"),
]

# 每个步骤需要的输入文件（从上一步输出推断）
STEP_INPUT_HINTS = {
    "denoise": "--input {wav}",
    "extract_anchor": "--input {output}/vocals/htdemucs/{replay_id}/vocals.wav",
    "transcribe": "--input {output}/anchor/vocals_anchor.wav",
    "clean": "",  # 自动扫描 transcript 目录
    "distill": "",  # 自动扫描 transcript 目录
    "compile": "",  # 自动扫描 distillation 目录
}


def get_python():
    """找到合适的 Python 解释器（优先 venv）"""
    # 检查是否存在 venv
    for candidate in [
        PIPELINE_DIR / ".venv-qwen3" / "Scripts" / "python.exe",
        PIPELINE_DIR / ".venv" / "Scripts" / "python.exe",
    ]:
        if candidate.exists():
            return str(candidate)
    return sys.executable


def check_step_done(step_name: str, output_dir: Path) -> bool:
    """检查某步骤是否已完成（通过 .step_*.json 状态文件）"""
    step_file = output_dir / f".step_{step_name}.json"
    return step_file.exists()


def run_pipeline_step(step_name: str, args: str = "", env: dict = None) -> bool:
    """运行单个管道步骤"""
    python = get_python()
    cmd = f'"{python}" "{PIPELINE_SCRIPT}" {step_name} {args}'

    print(f"\n{'='*60}")
    print(f"[pack] Running: {step_name}")
    print(f"[pack] Command: {cmd}")
    print(f"{'='*60}")

    try:
        result = subprocess.run(
            cmd,
            shell=True,
            cwd=str(PIPELINE_DIR),
            check=False,
        )
        return result.returncode == 0
    except Exception as e:
        print(f"[pack] ERROR: {e}")
        return False


def scan_wav_files(input_dir: Path) -> list:
    """扫描目录下的所有 WAV 文件"""
    wavs = sorted(input_dir.rglob("*.wav")) + sorted(input_dir.rglob("*.WAV"))
    return wavs


def discover_replay_id_from_vocals(output_dir: Path) -> str:
    """从已有的 Demucs 输出推断回放 ID"""
    vocals_dir = output_dir / "vocals" / "htdemucs"
    if vocals_dir.exists():
        for d in sorted(vocals_dir.iterdir()):
            if d.is_dir() and (d / "vocals.wav").exists():
                return d.name
    return None


def build_persona_card_from_profile(profile_path: Path, name: str, source_materials: list = None) -> dict:
    """从 persona_profile.json 构建人格卡"""
    profile = json.loads(profile_path.read_text(encoding="utf-8"))

    card = {
        "meta": {
            "card_id": name,
            "name": name,
            "version": "1.0.0",
            "created": date.today().isoformat(),
            "author": "persona-distill pipeline",
            "source": f"从 {len(source_materials or [])} 条直播回放蒸馏生成",
            "schema_version": "1.0",
            "description": f"{name} - 由 persona-distill 管道自动蒸馏",
            "tags": [],
            "language": "zh-CN",
            "license": "Proprietary"
        },
        "identity": {
            "name": name,
            "gender": "unknown",
            "persona_type": "streamer"
        },
        "system_prompt": "# TODO: 基于以下 personality_dimensions 编写 system prompt\n\n"
                         "此人格卡由蒸馏管道自动生成。personality_dimensions 包含从真实语音素材中提取的\n"
                         "口头禅、句式、情绪模式、互动模式等定量分析数据。\n\n"
                         "请参考这些维度手工编写 system_prompt 以创建可直灌 LLM 的完整人设。",
        "few_shot": [],
        "lore": {},
        "corrections": {"corrections": []},
        "personality_dimensions": profile.get("persona", {}),
        "source_materials": source_materials or []
    }

    return card


def enrich_card_meta(card: dict, name: str, source_count: int = 0) -> dict:
    """补充卡片元数据"""
    if not card.get("meta"):
        card["meta"] = {}
    card["meta"].setdefault("card_id", name)
    card["meta"].setdefault("name", name)
    card["meta"].setdefault("created", date.today().isoformat())
    card["meta"].setdefault("schema_version", "1.0")
    card["meta"]["source"] = f"从 {source_count} 条直播回放蒸馏生成"
    return card


def run_full_pipeline(wav_files: list, output_dir: Path, resume: bool, skip_steps: set = None):
    """运行完整蒸馏管道"""
    skip_steps = skip_steps or set()

    if not wav_files:
        print("[pack] No WAV files found.")
        return False

    print(f"[pack] Found {len(wav_files)} WAV file(s):")
    for w in wav_files[:10]:
        print(f"  - {w.name}")
    if len(wav_files) > 10:
        print(f"  ... and {len(wav_files) - 10} more")

    # 用第一个 WAV 文件
    first_wav = wav_files[0]
    replay_id = first_wav.stem

    # Step 1: Denoise
    if "denoise" not in skip_steps:
        if resume and check_step_done("denoise", output_dir):
            print(f"[pack] [SKIP] denoise already done")
        else:
            ok = run_pipeline_step("denoise", f'--input "{first_wav}"')
            if not ok:
                print("[pack] denoise failed, stopping")
                return False
    else:
        print("[pack] [SKIP] denoise (--skip-denoise)")

    # Step 2: Extract anchor
    if "extract_anchor" not in skip_steps:
        if resume and check_step_done("extract_anchor", output_dir):
            print(f"[pack] [SKIP] extract-anchor already done")
        else:
            vocals_path = output_dir / "vocals" / "htdemucs" / replay_id / "vocals.wav"
            if not vocals_path.exists():
                # 尝试自动发现
                rid = discover_replay_id_from_vocals(output_dir)
                if rid:
                    vocals_path = output_dir / "vocals" / "htdemucs" / rid / "vocals.wav"
            if vocals_path.exists():
                ok = run_pipeline_step("extract-anchor", f'--input "{vocals_path}"')
                if not ok:
                    print("[pack] extract-anchor failed, stopping")
                    return False
            else:
                print(f"[pack] WARNING: vocals.wav not found at {vocals_path}, trying diarize fallback")
                if resume and check_step_done("diarize", output_dir):
                    print(f"[pack] [SKIP] diarize already done")
                else:
                    ok = run_pipeline_step("diarize", f'--input "{vocals_path}"')
                    if not ok:
                        print("[pack] diarize failed, stopping")
                        return False

    # Step 3: Transcribe
    if "transcribe" not in skip_steps:
        if resume and check_step_done("transcribe", output_dir):
            print(f"[pack] [SKIP] transcribe already done")
        else:
            # 查找 anchor 输出
            anchor_wav = output_dir / "anchor" / "vocals_anchor.wav"
            if anchor_wav.exists():
                ok = run_pipeline_step("transcribe", f'--input "{anchor_wav}"')
                if not ok:
                    print("[pack] transcribe failed, stopping")
                    return False
            else:
                print(f"[pack] WARNING: anchor wav not found, skipping transcribe")

    # Step 3.5: Clean transcript
    if "clean" not in skip_steps:
        # Clean is triggered via pipeline.py clean command
        # It operates on output_dir/transcript/ directory
        ok = run_pipeline_step("clean")
        if not ok:
            print("[pack] WARNING: clean transcript had issues, continuing")

    # Step 4: Distill
    if "distill" not in skip_steps:
        if resume and check_step_done("distill", output_dir):
            print(f"[pack] [SKIP] distill already done")
        else:
            ok = run_pipeline_step("distill")
            if not ok:
                print("[pack] distill failed, stopping")
                return False

    # Step 5: Compile
    if "compile" not in skip_steps:
        if resume and check_step_done("compile", output_dir):
            print(f"[pack] [SKIP] compile already done")
        else:
            ok = run_pipeline_step("compile")
            if not ok:
                print("[pack] compile failed, stopping")
                return False

    return True


def validate_card(card_path: Path) -> bool:
    """调用 validate_card.py 校验人格卡"""
    python = get_python()
    validate_script = TOOLS_DIR / "validate_card.py"
    cmd = f'"{python}" "{validate_script}" "{card_path}"'
    result = subprocess.run(cmd, shell=True, cwd=str(PIPELINE_DIR), check=False)
    return result.returncode == 0


def main():
    parser = argparse.ArgumentParser(
        description="一键蒸馏 + 打包人格卡",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__
    )
    parser.add_argument("--input", "-i", help="WAV 文件或目录路径")
    parser.add_argument("--name", "-n", default="distilled-character",
                        help="人设名称（用作 card_id 和输出目录名）")
    parser.add_argument("--from-profile", help="从已有 persona_profile.json 打包（跳过蒸馏）")
    parser.add_argument("--output-dir", default=str(OUTPUT_DIR),
                        help=f"管道产物输出目录 (默认: {OUTPUT_DIR})")
    parser.add_argument("--resume", action="store_true",
                        help="断点续跑：跳过已完成步骤")
    parser.add_argument("--skip-denoise", action="store_true")
    parser.add_argument("--skip-extract-anchor", action="store_true")
    parser.add_argument("--skip-transcribe", action="store_true")
    parser.add_argument("--skip-distill", action="store_true")
    parser.add_argument("--skip-compile", action="store_true")
    parser.add_argument("--skip-validate", action="store_true",
                        help="跳过 Schema 校验")
    parser.add_argument("--validate-only", help="仅校验指定的人格卡 JSON")
    parser.add_argument("--verbose", "-v", action="store_true")

    args = parser.parse_args()

    # --validate-only 模式
    if args.validate_only:
        card_path = Path(args.validate_only)
        if not card_path.exists():
            print(f"[ERROR] 文件不存在: {card_path}")
            sys.exit(1)
        ok = validate_card(card_path)
        print(f"\n{'='*50}")
        print(f"校验结果: {'PASS' if ok else 'FAIL'}")
        sys.exit(0 if ok else 1)

    output_dir = Path(args.output_dir)
    card_name = args.name

    # --from-profile 模式：直接从已有 profile 打包
    if args.from_profile:
        profile_path = Path(args.from_profile)
        if not profile_path.exists():
            print(f"[ERROR] Profile 文件不存在: {profile_path}")
            sys.exit(1)

        print(f"[pack] 从已有 profile 打包: {profile_path}")
        card = build_persona_card_from_profile(profile_path, card_name)
        card = enrich_card_meta(card, card_name)

        # 输出
        card_dir = PERSONA_CARDS_DIR / card_name
        card_dir.mkdir(parents=True, exist_ok=True)
        card_path = card_dir / "persona-card.json"
        card_path.write_text(json.dumps(card, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"[pack] 人格卡已生成: {card_path}")

        if not args.skip_validate:
            print(f"\n[pack] 校验人格卡...")
            if validate_card(card_path):
                print(f"[pack] [OK] 校验通过")
            else:
                print(f"[pack] [WARN] 校验未通过，但卡片已生成")
        return

    # --input 模式：运行完整蒸馏管道
    if not args.input:
        parser.print_help()
        print("\n[ERROR] 需要 --input 或 --from-profile 或 --validate-only")
        sys.exit(1)

    input_path = Path(args.input)
    if input_path.is_file():
        wav_files = [input_path]
    elif input_path.is_dir():
        wav_files = scan_wav_files(input_path)
    else:
        print(f"[ERROR] 输入路径不存在: {input_path}")
        sys.exit(1)

    # 收集跳过的步骤
    skip_steps = set()
    if args.skip_denoise:
        skip_steps.add("denoise")
    if args.skip_extract_anchor:
        skip_steps.add("extract_anchor")
    if args.skip_transcribe:
        skip_steps.add("transcribe")
    if args.skip_distill:
        skip_steps.add("distill")
    if args.skip_compile:
        skip_steps.add("compile")

    # 运行管道
    ok = run_full_pipeline(wav_files, output_dir, args.resume, skip_steps)
    if not ok:
        print("[pack] 管道运行失败")
        sys.exit(1)

    # 查找 compile 输出
    profile_path = output_dir / "compile" / "persona_profile.json"
    if not profile_path.exists():
        print(f"[pack] WARNING: profile 未找到: {profile_path}")
        print("[pack] 管道步骤已完成，但未生成 persona_profile.json。请检查输出目录。")
        sys.exit(1)

    # 构建人格卡
    print(f"\n[pack] 从 {profile_path} 构建人格卡...")
    card = build_persona_card_from_profile(profile_path, card_name, [
        {"type": "audio", "path": str(w), "description": w.name}
        for w in wav_files
    ])
    card = enrich_card_meta(card, card_name, len(wav_files))

    # 输出
    card_dir = PERSONA_CARDS_DIR / card_name
    card_dir.mkdir(parents=True, exist_ok=True)
    card_path = card_dir / "persona-card.json"
    card_path.write_text(json.dumps(card, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[pack] 人格卡已生成: {card_path}")
    print(f"   大小: {card_path.stat().st_size / 1024:.1f} KB")

    # 校验
    if not args.skip_validate:
        print(f"\n[pack] 校验人格卡...")
        if validate_card(card_path):
            print(f"[pack] [OK] 校验通过")
        else:
            print(f"[pack] [WARN] 校验未通过，但卡片已生成。请检查 Schema 合规性。")

    # 摘要
    pdims = card.get("personality_dimensions", {})
    if pdims:
        print(f"\n[pack] 维度覆盖摘要:")
        for dim_name, dim_data in pdims.items():
            if dim_data:
                # 统计内容
                if isinstance(dim_data, dict):
                    key_count = sum(1 for v in dim_data.values() if v)
                    print(f"  {dim_name}: {key_count} 个子维度有数据")
                else:
                    print(f"  {dim_name}: [OK]")

    print(f"\n[pack] Done! 人格卡位置: {card_path}")
    print(f"  下一步: python tools/validate_card.py {card_path}")


if __name__ == "__main__":
    main()
