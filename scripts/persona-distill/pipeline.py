#!/usr/bin/env python3
"""
元元人设蒸馏管道 - 主控脚本
=============================

将直播回放 WAV 文件转化为结构化人设配置的完整管道。

管线:
  1. denoise        - Demucs 去除背景音乐/音效 → vocals.wav
  2. extract_anchor - VAD + CAM++ sub-chunk + MossFormer2 TSE → 干净主播语音
     (fallback)     - FSMN-VAD + CAM++/KMeans 说话人分离 → 拼接主播语音
  3. transcribe     - SenseVoice ASR 转录
  3.5 clean         - 移除转录中的背景歌词碎片
  4. distill        - LLM 提取 8 个维度的人格模式
  5. compile        - 编译为结构化 persona profile

用法:
  # 一键运行完整管道（自动选择 enhanced 或 simple 模式）
  python pipeline.py run --input sample_wav/live_001.wav

  # 逐步运行（调试用）
  python pipeline.py denoise --input sample_wav/live_001.wav
  python pipeline.py extract-anchor --input output/vocals/htdemucs/live_001/vocals.wav
  python pipeline.py transcribe --input output/anchor/vocals_anchor.wav
  python pipeline.py distill
  python pipeline.py compile

  # 批量处理目录
  python pipeline.py run --dir sample_wav/

依赖:
  Python 3.10-3.13 + torch (cu128 for RTX 5080)
  运行前请先: powershell -ExecutionPolicy Bypass -File setup.ps1
"""

import argparse
import json
import sys
import warnings
from pathlib import Path
from typing import Optional

import yaml

# 添加 steps 目录到 path
sys.path.insert(0, str(Path(__file__).parent))
from steps import denoise, diarize, transcribe, distill, compile
from steps import clean_transcript, isolation, extract_anchor


# ---------------------------------------------------------------------------
# 配置加载
# ---------------------------------------------------------------------------

def load_config(config_path: Optional[Path] = None) -> dict:
    """加载并合并配置"""
    if config_path is None:
        config_path = Path(__file__).parent / "config.yaml"

    with open(config_path, "r", encoding="utf-8") as f:
        config = yaml.safe_load(f)

    # 设置默认值
    root = Path(__file__).parent
    config.setdefault("paths", {})
    config["paths"].setdefault("wav_dir", str(root / "sample_wav"))
    config["paths"].setdefault("output_dir", str(root / "output"))
    config["paths"].setdefault("reference_wav", None)

    # 解析参考音频路径
    ref_wav = config["paths"]["reference_wav"]
    if ref_wav and not Path(ref_wav).is_absolute():
        config["paths"]["reference_wav"] = str(root / ref_wav)

    return config


# ---------------------------------------------------------------------------
# CLI 命令
# ---------------------------------------------------------------------------

def cmd_denoise(args, config):
    """Step 1: 背景音乐去除"""
    cfg = config["denoise"]
    paths = config["paths"]

    input_path = Path(args.input)
    if not input_path.exists():
        print(f"ERROR: Input file not found: {input_path}")
        sys.exit(1)

    output_dir = Path(paths["output_dir"]) / "vocals"

    result = denoise.run_demucs(
        input_path=input_path,
        output_dir=output_dir,
        model=cfg["model"],
        device=cfg["device"],
        segment=cfg["segment"],
        overlap=cfg["overlap"],
    )

    # 保存结果路径供下一步使用
    step_result = {"vocals_path": str(result)}
    _save_step_result("denoise", step_result, Path(paths["output_dir"]))
    print(f"\n[denoise] Complete. Next: pipeline.py diarize --input {result}")


def cmd_diarize(args, config):
    """Step 2: 说话人分离 + 元元识别"""
    cfg = config["diarize"]
    paths = config["paths"]

    input_path = Path(args.input)
    if not input_path.exists():
        print(f"ERROR: Input file not found: {input_path}")
        sys.exit(1)

    # 从 Demucs 输出路径推演回放名（vocals/htdemucs/<episode>/vocals.wav）
    replay_id = input_path.parent.name if input_path.parent.name != "htdemucs" else _sanitize_replay_id(input_path.stem)
    output_dir = Path(paths["output_dir"]) / "speaker"
    output_path = output_dir / f"{replay_id}_yuanyuan.wav"

    print(f"\n[diarize] Processing: {input_path}")
    print(f"[diarize] Output: {output_path}")

    # 1. VAD
    segments = diarize.extract_vad_segments(
        input_path,
        device=cfg.get("device", "cuda"),
        max_segment_ms=cfg.get("max_segment_ms", 30000),
    )
    if not segments:
        print("[diarize] No speech detected. Aborting.")
        sys.exit(1)

    # 2. Speaker embeddings
    embeddings = diarize.extract_speaker_embeddings(
        input_path, segments, device=cfg.get("device", "cuda")
    )

    # 3. Get reference voiceprint (optional)
    ref_path = paths.get("reference_wav")
    reference_emb = diarize.get_reference_embedding(
        Path(ref_path) if ref_path else None,
        device=cfg.get("device", "cuda"),
    )

    # 4. Identify 元元
    yuanyuan_idx = diarize.identify_yuanyuan(
        segments,
        embeddings,
        reference_emb=reference_emb,
        threshold=cfg.get("similarity_threshold", 0.6),
        fallback_strategy=cfg.get("fallback_strategy", "largest_cluster"),
    )

    if not yuanyuan_idx:
        print("[diarize] No 元元 segments identified. Aborting.")
        sys.exit(1)

    # 5. Build output WAV
    output, metadata = diarize.build_yuanyuan_wav(
        input_path, segments, yuanyuan_idx, output_path
    )

    # 保存结果
    step_result = {
        "yuanyuan_wav": str(output),
        "total_segments": len(segments),
        "yuanyuan_segments": len(yuanyuan_idx),
        "metadata": str(output.with_suffix(".diarize.json")),
    }
    _save_step_result("diarize", step_result, Path(paths["output_dir"]))
    print(f"\n[diarize] Complete. Next: pipeline.py transcribe --input {output}")


def cmd_transcribe(args, config):
    """Step 3: SenseVoice ASR 转录"""
    cfg = config["asr"]
    paths = config["paths"]

    output_dir = Path(paths["output_dir"]) / "transcript"

    if args.input:
        input_path = Path(args.input)
        if not input_path.exists():
            print(f"ERROR: Input file not found: {input_path}")
            sys.exit(1)

        result = transcribe.transcribe_with_sensevoice(
            input_path, output_dir,
            model_name=cfg["model"],
            device=cfg["device"],
            language=cfg.get("language", "zh"),
            itn=cfg.get("itn", True),
        )

        step_result = {
            "transcript_dir": str(output_dir),
            "char_count": result["char_count"],
        }
    else:
        # 批量转录 speaker 目录中的所有 WAV
        speaker_dir = Path(paths["output_dir"]) / "speaker"
        results = transcribe.batch_transcribe(
            speaker_dir, output_dir,
            model_name=cfg["model"],
            device=cfg["device"],
            language=cfg.get("language", "zh"),
            itn=cfg.get("itn", True),
        )

        total_chars = sum(r.get("char_count", 0) for r in results if "error" not in r)
        step_result = {
            "transcript_dir": str(output_dir),
            "files_processed": len(results),
            "total_chars": total_chars,
        }

    _save_step_result("transcribe", step_result, Path(paths["output_dir"]))
    print(f"\n[transcribe] Complete. Next: pipeline.py distill")


def cmd_distill(args, config):
    """Step 4: LLM 人设蒸馏提取"""
    distill_cfg = config.get("distill", {})
    paths = config["paths"]
    root = Path(__file__).parent

    output_dir = Path(paths["output_dir"]) / "distillation"
    # 优先使用清洗后的转录，回退到原始转录
    clean_dir = Path(paths["output_dir"]) / "transcript_cleaned"
    raw_dir = Path(paths["output_dir"]) / "transcript"
    if clean_dir.exists() and list(clean_dir.glob("*.txt")):
        transcript_dir = clean_dir
        print("[distill] Using cleaned transcripts")
    else:
        transcript_dir = raw_dir
        print("[distill] Using raw transcripts")
    prompts_dir = root / "prompts"

    results = distill.distill_persona(
        transcript_dir=transcript_dir,
        output_dir=output_dir,
        prompts_dir=prompts_dir,
        config=config,
    )

    step_result = {
        "distillation_dir": str(output_dir),
        "dimensions_extracted": list(results.keys()),
        "errors": [k for k, v in results.items() if v.get("error")],
    }
    _save_step_result("distill", step_result, Path(paths["output_dir"]))
    print(f"\n[distill] Complete. Next: pipeline.py compile")


def cmd_compile(args, config):
    """Step 5: 编译为结构化 persona profile"""
    compile_cfg = config.get("compile", {})
    paths = config["paths"]
    root = Path(__file__).parent

    output_dir = Path(paths["output_dir"]) / "compile"
    distillation_dir = Path(paths["output_dir"]) / "distillation"
    result_path = distillation_dir / "distillation_result.json"

    if not result_path.exists():
        print(f"ERROR: Distillation result not found: {result_path}")
        print("Please run 'pipeline.py distill' first")
        sys.exit(1)

    with open(result_path, "r", encoding="utf-8") as f:
        distillation_results = json.load(f)

    current_persona = compile_cfg.get("current_persona_path")
    if current_persona and not Path(current_persona).is_absolute():
        current_persona = str(root / current_persona)

    profile = compile.compile_profile(
        distillation_results=distillation_results,
        output_dir=output_dir,
        format=compile_cfg.get("format", "json"),
        comparison_report=compile_cfg.get("comparison_report", True),
        current_persona_path=current_persona,
    )

    step_result = {
        "profile_path": str(output_dir / "persona_profile.json"),
        "dimensions": list(profile.get("persona", {}).keys()),
    }
    _save_step_result("compile", step_result, Path(paths["output_dir"]))

    print("\n[compile] Complete!")
    print(f"  Profile: {output_dir / 'persona_profile.json'}")
    if compile_cfg.get("comparison_report"):
        print(f"  Comparison: {output_dir / 'comparison_report.json'}")


def cmd_run(args, config):
    """一键运行完整管道

    --stop-at 可选值:
      denoise    - 只做完 Step 1（背景音乐去除）
      extract    - 做完 Step 2（说话人提取）即停止
      transcribe - 做完 Step 3（ASR转录）即停止
      clean      - 做完 Step 3.5（清洗歌词）即停止
      不指定     - 跑完全部 5 步
    """
    paths = config["paths"]
    output_dir = Path(paths["output_dir"])
    stop_at = getattr(args, 'stop_at', None)
    stop_order = {"denoise": 1, "extract": 2, "transcribe": 3, "clean": 4}
    stop_step = stop_order.get(stop_at, 99)

    # 收集输入文件
    wav_files = []
    if args.input:
        p = Path(args.input)
        if p.exists():
            wav_files = [p]
        else:
            print(f"ERROR: Input not found: {p}")
            sys.exit(1)
    elif args.dir:
        d = Path(args.dir)
        _wav_set = {p.resolve() for p in list(d.glob("*.wav")) + list(d.glob("*.WAV"))}
        wav_files = sorted(_wav_set)
        if not wav_files:
            print(f"ERROR: No WAV files found in {d}")
            sys.exit(1)
    else:
        d = Path(paths["wav_dir"])
        _wav_set = {p.resolve() for p in list(d.glob("*.wav")) + list(d.glob("*.WAV"))}
        wav_files = sorted(_wav_set)
        if not wav_files:
            print(f"ERROR: No WAV files found in {d}")
            print("Please add WAV files to sample_wav/ or use --input/--dir")
            sys.exit(1)

    print(f"\n{'='*60}")
    print(f"Persona Distillation Pipeline")
    if stop_at:
        print(f"  (stop-at: {stop_at})")
    print(f"{'='*60}")
    print(f"Files to process: {len(wav_files)}")
    for f in wav_files[:5]:
        print(f"  - {f.name}")
    if len(wav_files) > 5:
        print(f"  ... and {len(wav_files) - 5} more")
    print(f"Output directory: {output_dir}")
    print(f"{'='*60}\n")

    # 处理每个文件
    all_yuanyuan_wavs = []
    for i, wav_file in enumerate(wav_files):
        # 用原始直播回放文件名作为唯一标识，避免不同回放覆盖
        replay_id = _sanitize_replay_id(wav_file.stem)
        header = f"File {i + 1}/{len(wav_files)}: {wav_file.name}"
        print(f"\n{'='*60}")
        print(header)
        print(f"  replay_id: {replay_id}")
        print(f"{'='*60}")

        # Step 1: Denoise
        if config.get("denoise", {}).get("enabled", True):
            d_cfg = config["denoise"]
            result = denoise.run_demucs(
                input_path=wav_file,
                output_dir=output_dir / "vocals",
                model=d_cfg["model"],
                device=d_cfg["device"],
                segment=d_cfg["segment"],
                overlap=d_cfg["overlap"],
            )
            vocals_path = result
        else:
            vocals_path = wav_file
            print(f"[pipeline] Denoise disabled, using raw audio")

        # Step 2: Speaker extraction (extract_anchor or diarize fallback)
        if config.get("diarize", {}).get("enabled", True):
            d_cfg = config["diarize"]
            ref_path = paths.get("reference_wav")
            ref_wav = Path(ref_path) if ref_path and Path(ref_path).exists() else None

            # 优先使用 enhanced extract_anchor（需要参考音频）
            use_enhanced = (
                ref_wav is not None
                and config.get("extract_anchor", {}).get("enabled", True)
            )

            if use_enhanced:
                ea_cfg = config.get("extract_anchor", {})
                anchor_dir = output_dir / "anchor"
                print(f"\n[pipeline] Using enhanced speaker extraction "
                      f"(VAD + CAM++ sub-chunk + MossFormer2 TSE)")

                anchor_wav = extract_anchor.extract_anchor_speech(
                    vocals_path=vocals_path,
                    output_dir=anchor_dir,
                    reference_wav=ref_wav,
                    device=ea_cfg.get("device", d_cfg.get("device", "cuda")),
                    similarity_threshold=ea_cfg.get("similarity_threshold", 0.38),
                    chunk_duration_s=ea_cfg.get("chunk_duration_s", 300),
                    margin_ms=ea_cfg.get("margin_ms", 300),
                    force=args.force if hasattr(args, 'force') else False,
                    name=replay_id,
                )
                if anchor_wav:
                    all_yuanyuan_wavs.append(anchor_wav)
                else:
                    print(f"[pipeline] WARNING: extract_anchor failed for {wav_file.name}")
            else:
                # Fallback: simple diarize
                output_path = output_dir / "speaker" / f"{replay_id}_yuanyuan.wav"

                segments = diarize.extract_vad_segments(vocals_path, device=d_cfg.get("device", "cuda"))
                if segments:
                    embeddings = diarize.extract_speaker_embeddings(vocals_path, segments, device=d_cfg.get("device", "cuda"))
                    reference_emb = diarize.get_reference_embedding(ref_wav, device=d_cfg.get("device", "cuda"))
                    yy_idx = diarize.identify_yuanyuan(
                        segments, embeddings, reference_emb=reference_emb,
                        threshold=d_cfg.get("similarity_threshold", 0.6),
                        fallback_strategy=d_cfg.get("fallback_strategy", "largest_cluster"),
                    )
                    if yy_idx:
                        yuanyuan_wav, _ = diarize.build_yuanyuan_wav(vocals_path, segments, yy_idx, output_path)
                        all_yuanyuan_wavs.append(yuanyuan_wav)
                    else:
                        print(f"[pipeline] WARNING: No 元元 segments in {wav_file.name}")
                else:
                    print(f"[pipeline] WARNING: No speech in {wav_file.name}")
        else:
            all_yuanyuan_wavs.append(vocals_path)
            print(f"[pipeline] Diarize disabled, using full audio as 元元")

    if not all_yuanyuan_wavs:
        print("ERROR: No 元元 audio extracted from any file. Aborting.")
        sys.exit(1)

    if stop_step <= 2:
        print(f"\n[pipeline] Stopped after extract (stop-at={stop_at})")
        print(f"  Extracted {len(all_yuanyuan_wavs)} anchor WAVs to: {output_dir / 'anchor'}")
        return

    # Step 3: Transcribe (batch)
    print(f"\n{'='*60}")
    print(f"Step 3: Transcribing {len(all_yuanyuan_wavs)} files...")
    print(f"{'='*60}")

    a_cfg = config["asr"]
    transcript_dir = output_dir / "transcript"
    for yy_wav in all_yuanyuan_wavs:
        try:
            transcribe.transcribe_with_sensevoice(
                yy_wav, transcript_dir,
                model_name=a_cfg["model"],
                device=a_cfg["device"],
                language=a_cfg.get("language", "zh"),
                itn=a_cfg.get("itn", True),
            )
        except Exception as e:
            print(f"[pipeline] ERROR transcribing {yy_wav.name}: {e}")

    if stop_step <= 3:
        print(f"\n[pipeline] Stopped after transcribe (stop-at={stop_at})")
        print(f"  Transcripts saved to: {transcript_dir}")
        return

    # Step 3.5: Clean transcript (remove background song lyrics)
    if config.get("transcript_clean", {}).get("enabled", True):
        print(f"\n{'='*60}")
        print(f"Step 3.5: Cleaning transcript (removing song lyrics)...")
        print(f"{'='*60}")
        transcript_clean_dir = output_dir / "transcript"
        clean_stats = clean_transcript.batch_clean(
            transcript_dir=transcript_dir,
            output_dir=transcript_clean_dir,
            verbose=config.get("transcript_clean", {}).get("verbose", False),
        )
        # Use cleaned transcript for distillation
        # (clean_transcript overwrites files in-place in the transcript dir)
        transcript_dir = transcript_clean_dir

    if stop_step <= 4:
        print(f"\n[pipeline] Stopped after clean (stop-at={stop_at})")
        print(f"  Cleaned transcripts: {transcript_dir}")
        print(f"  Ready for IDE-based LLM distillation")
        return

    # Step 4: Distill
    print(f"\n{'='*60}")
    print(f"Step 4: LLM Distillation")
    print(f"{'='*60}")

    root = Path(__file__).parent
    distill_results = distill.distill_persona(
        transcript_dir=transcript_dir,
        output_dir=output_dir / "distillation",
        prompts_dir=root / "prompts",
        config=config,
    )

    # Step 5: Compile
    print(f"\n{'='*60}")
    print(f"Step 5: Compiling Persona Profile")
    print(f"{'='*60}")

    compile_cfg = config.get("compile", {})
    current_persona = compile_cfg.get("current_persona_path")
    if current_persona and not Path(current_persona).is_absolute():
        current_persona = str(root / current_persona)

    profile = compile.compile_profile(
        distillation_results=distill_results,
        output_dir=output_dir / "compile",
        format=compile_cfg.get("format", "json"),
        comparison_report=compile_cfg.get("comparison_report", True),
        current_persona_path=current_persona,
    )

    print(f"\n{'='*60}")
    print(f"Pipeline Complete!")
    print(f"{'='*60}")
    print(f"  Transcripts:  {transcript_dir}")
    print(f"  Distillation: {output_dir / 'distillation'}")
    print(f"  Profile:      {output_dir / 'compile' / 'persona_profile.json'}")
    print(f"{'='*60}")


def cmd_extract_anchor(args, config):
    """增强版说话人提取：VAD + CAM++ sub-chunk + MossFormer2 语音分离"""
    paths = config["paths"]
    d_cfg = config.get("diarize", {})
    ea_cfg = config.get("extract_anchor", {})

    if not args.input:
        print("ERROR: --input required (vocals.wav path)")
        sys.exit(1)

    input_path = Path(args.input)
    if not input_path.exists():
        print(f"ERROR: {input_path} not found")
        sys.exit(1)

    output_dir = Path(paths["output_dir"]) / "anchor"
    ref_path = args.reference or paths.get("reference_wav")
    if ref_path:
        ref_path = Path(ref_path)
        if not ref_path.exists():
            print(f"WARNING: Reference WAV not found: {ref_path}")
            ref_path = None

    device = ea_cfg.get("device", d_cfg.get("device", "cuda"))
    threshold = args.threshold or ea_cfg.get("similarity_threshold", 0.38)
    chunk_s = ea_cfg.get("chunk_duration_s", 300)
    margin = ea_cfg.get("margin_ms", 300)

    output_wav = extract_anchor.extract_anchor_speech(
        vocals_path=input_path,
        output_dir=output_dir,
        reference_wav=ref_path,
        device=device,
        similarity_threshold=threshold,
        chunk_duration_s=chunk_s,
        margin_ms=margin,
        force=args.force,
        keep_intermediates=args.keep_intermediates,
        name=args.name if hasattr(args, 'name') and args.name else None,
    )

    if output_wav is None:
        print("[extract_anchor] Failed!")
        sys.exit(1)

    # 保存步骤结果
    step_result = {
        "anchor_wav": str(output_wav),
        "method": "isolation + MossFormer2_SS_16K + CAM++",
    }
    _save_step_result("extract_anchor", step_result, Path(paths["output_dir"]))
    print(f"\n[extract_anchor] Done. Next: pipeline.py transcribe --input {output_wav}")


def cmd_status(args, config):
    """查看管道运行状态"""
    paths = config["paths"]
    output_dir = Path(paths["output_dir"])

    print("\nPipeline Status:")
    print(f"  Output dir: {output_dir}")

    steps_status = []
    for step_name in ["denoise", "diarize", "transcribe", "distill", "compile"]:
        step_file = output_dir / f".step_{step_name}.json"
        if step_file.exists():
            with open(step_file, "r") as f:
                data = json.load(f)
            steps_status.append((step_name, "DONE", data.get("timestamp", "?")))
        else:
            steps_status.append((step_name, "PENDING", "-"))

    for name, status, ts in steps_status:
        icon = "✓" if status == "DONE" else "○"
        print(f"  {icon} {name:<15} {status:<8} {ts}")


# ---------------------------------------------------------------------------
# 工具函数
# ---------------------------------------------------------------------------

def _sanitize_replay_id(raw: str) -> str:
    """从原始文件名提取安全的唯一标识，过滤空格与特殊字符"""
    import re
    # 保留中文、字母、数字、下划线、连字符，其余替换为下划线
    sanitized = re.sub(r'[^\w\u4e00-\u9fff-]', '_', raw)
    # 合并连续下划线
    sanitized = re.sub(r'_+', '_', sanitized).strip('_')
    return sanitized or "unknown_replay"


def _save_step_result(step_name: str, data: dict, output_dir: Path):
    """保存步骤结果供状态追踪"""
    from datetime import datetime
    data["timestamp"] = datetime.now().isoformat()
    data["step"] = step_name
    step_file = output_dir / f".step_{step_name}.json"
    with open(step_file, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def cmd_clean(args, config):
    """清洗转录文本中的歌词碎片（独立运行）"""
    paths = config["paths"]
    clean_cfg = config.get("transcript_clean", {})

    if not args.input:
        print("ERROR: --input required")
        sys.exit(1)

    input_path = Path(args.input)
    if not input_path.exists():
        print(f"ERROR: {input_path} not found")
        sys.exit(1)

    if args.output:
        output_dir = Path(args.output)
    else:
        output_dir = input_path.parent / "cleaned"

    if input_path.is_dir():
        clean_transcript.batch_clean(
            input_path, output_dir,
            verbose=clean_cfg.get("verbose", args.verbose),
        )
    else:
        out_path = output_dir / input_path.name if output_dir.is_dir() else output_dir
        stats = clean_transcript.clean_transcript(
            input_path, out_path,
            verbose=clean_cfg.get("verbose", args.verbose),
        )
        print(f"\nStats: {stats}")


def cmd_isolation(args, config):
    """声源隔离：从 vocals 轨中只保留元元声音，其余静音"""
    paths = config["paths"]
    output_dir = Path(paths["output_dir"])

    if not args.input:
        print("ERROR: --input required (vocals.wav path)")
        sys.exit(1)

    input_path = Path(args.input)
    if not input_path.exists():
        print(f"ERROR: {input_path} not found")
        sys.exit(1)

    if args.output:
        output_path = Path(args.output)
    else:
        output_dir_isolation = output_dir / "isolation"
        output_dir_isolation.mkdir(parents=True, exist_ok=True)
        output_path = output_dir_isolation / "filtered_vocals.wav"

    ref_path = args.reference or paths.get("reference_wav")
    if ref_path:
        ref_path = Path(ref_path)
        if not ref_path.exists():
            print(f"WARNING: Reference WAV not found: {ref_path}, using clustering mode")
            ref_path = None

    d_cfg = config.get("diarize", {})

    result, stats = isolation.isolate_speaker(
        vocals_path=input_path,
        output_path=output_path,
        reference_wav=ref_path,
        device=d_cfg.get("device", "cuda"),
        similarity_threshold=args.threshold or d_cfg.get("similarity_threshold", 0.6),
        max_segment_ms=d_cfg.get("max_segment_ms", 30000),
        min_segment_ms=d_cfg.get("min_segment", 500),
        fade_ms=args.fade_ms,
    )

    print(f"\n[isolation] Complete!")
    print(f"  Filtered audio: {output_path}")
    print(f"  Metadata:       {output_path.with_suffix('.isolation.json')}")
    print(f"  元元保留: {stats['yuanyuan_duration_s']:.1f}s / {stats['total_duration_s']:.1f}s "
          f"({100 * stats['yuanyuan_duration_s'] / max(1, stats['total_duration_s']):.1f}%)")
    print(f"  被静音:   {stats['other_duration_s']:.1f}s (其他说话人/背景唱歌)")


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="元元人设蒸馏管道",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )

    parser.add_argument(
        "--config", "-c",
        type=Path,
        default=None,
        help="配置文件路径（默认: config.yaml）",
    )

    subparsers = parser.add_subparsers(dest="command", help="管道步骤")

    # denoise
    p_denoise = subparsers.add_parser("denoise", help="Step 1: 背景音乐去除")
    p_denoise.add_argument("--input", "-i", required=True, help="输入 WAV 文件")

    # diarize
    p_diarize = subparsers.add_parser("diarize", help="Step 2: 说话人分离")
    p_diarize.add_argument("--input", "-i", required=True, help="输入 WAV 文件（降噪后的人声）")

    # transcribe
    p_transcribe = subparsers.add_parser("transcribe", help="Step 3: 语音识别")
    p_transcribe.add_argument("--input", "-i", default=None, help="输入 WAV 文件（元元语音）")

    # distill
    p_distill = subparsers.add_parser("distill", help="Step 4: LLM 人设蒸馏")

    # clean (standalone)
    p_clean = subparsers.add_parser("clean", help="清洗转录文本中的歌词碎片")
    p_clean.add_argument("--input", "-i", required=True, help="输入转录 .txt 文件或目录")
    p_clean.add_argument("--output", "-o", default=None, help="输出路径")
    p_clean.add_argument("--verbose", "-v", action="store_true", help="详细日志")

    # isolation (standalone)
    p_isolation = subparsers.add_parser("isolation", help="声源隔离：从 vocals 轨只保留元元声音")
    p_isolation.add_argument("--input", "-i", required=True, help="输入 vocals.wav 文件")
    p_isolation.add_argument("--output", "-o", default=None, help="输出 filtered_vocals.wav 路径")
    p_isolation.add_argument("--reference", "-r", default=None, help="元元参考声纹 WAV")
    p_isolation.add_argument("--threshold", "-t", type=float, default=None, help="声纹匹配阈值")
    p_isolation.add_argument("--fade-ms", type=int, default=15, help="段边界淡化毫秒数")

    # extract_anchor (enhanced speaker extraction)
    p_extract = subparsers.add_parser(
        "extract-anchor", aliases=["ea"],
        help="增强版说话人提取：VAD + CAM++ sub-chunk + MossFormer2 TSE → 干净主播语音",
    )
    p_extract.add_argument("--input", "-i", required=True, help="输入 vocals.wav（Demucs 输出）")
    p_extract.add_argument("--reference", "-r", default=None, help="元元参考声纹 WAV")
    p_extract.add_argument("--threshold", "-t", type=float, default=None, help="CAM++ 匹配阈值")
    p_extract.add_argument("--force", "-f", action="store_true", help="忽略缓存重新处理")
    p_extract.add_argument("--keep-intermediates", action="store_true", help="保留中间 WAV 文件")
    p_extract.add_argument("--name", default=None, help="输出文件名前缀（用于区分不同回放，默认提取自输入路径）")

    # compile
    p_compile = subparsers.add_parser("compile", help="Step 5: 编译 persona profile")

    # run (all steps)
    p_run = subparsers.add_parser("run", help="一键运行完整管道")
    p_run.add_argument("--input", "-i", default=None, help="单个输入 WAV 文件")
    p_run.add_argument("--dir", "-d", default=None, help="输入 WAV 目录（批量处理）")
    p_run.add_argument("--stop-at", default=None,
                       choices=["denoise", "extract", "transcribe", "clean"],
                       help="在指定步骤后停止（用于分阶段运行：GPU步骤→IDE蒸馏→编译）")

    # status
    p_status = subparsers.add_parser("status", help="查看管道运行状态")

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(0)

    # 加载配置
    config = load_config(args.config)

    # Suppress common warnings
    warnings.filterwarnings("ignore", category=FutureWarning)
    warnings.filterwarnings("ignore", category=UserWarning, module="torch")

    # 路由命令
    command_map = {
        "denoise": cmd_denoise,
        "diarize": cmd_diarize,
        "isolation": cmd_isolation,
        "extract-anchor": cmd_extract_anchor,
        "ea": cmd_extract_anchor,
        "transcribe": cmd_transcribe,
        "clean": cmd_clean,
        "distill": cmd_distill,
        "compile": cmd_compile,
        "run": cmd_run,
        "status": cmd_status,
    }

    command_map[args.command](args, config)


if __name__ == "__main__":
    main()
