"""
Step 5: 编译蒸馏结果为结构化人设配置
将 LLM 提取的各维度结果编译为结构化的 persona profile，
可选生成与当前 system prompt 的对比报告。
"""

import json
import re
from pathlib import Path
from typing import Dict, List, Optional


def compile_profile(
    distillation_results: Dict,
    output_dir: Path,
    format: str = "json",
    comparison_report: bool = False,
    current_persona_path: Optional[str] = None,
) -> Dict:
    """
    将蒸馏结果编译为结构化的 persona profile。

    Args:
        distillation_results: 从 distill.py 输出的维度提取结果
        output_dir: 输出目录
        format: 输出格式 (json/yaml/markdown)
        comparison_report: 是否生成对比报告
        current_persona_path: 当前 persona-assets.js 路径

    Returns:
        Dict: 编译后的人格配置
    """
    output_dir.mkdir(parents=True, exist_ok=True)

    profile = {
        "meta": {
            "version": "1.0",
            "generated_from": "persona-distill pipeline",
            "dimensions_extracted": list(distillation_results.keys()),
        },
        "persona": {},
    }

    # 映射维度名到 profile 字段
    field_mapping = {
        "catchphrases": "catchphrases",
        "sentence_style": "sentence_style",
        "stuttering": "stuttering_patterns",
        "emotional_pattern": "emotional_pattern",
        "interaction": "interaction_pattern",
        "dialect": "dialect_features",
        "self_reference": "self_reference",
        "audience_address": "audience_address",
        "topic_preference": "topic_preference",
    }

    # 将原始 LLM 输出解析为结构化字段
    for dim_name, dim_data in distillation_results.items():
        field = field_mapping.get(dim_name, dim_name)
        raw = dim_data.get("raw_result", "")
        if dim_data.get("error"):
            profile["persona"][field] = {"error": dim_data["error"]}
        else:
            profile["persona"][field] = {
                "raw": raw.strip(),
                "structured": _parse_dimension_text(dim_name, raw),
            }

    # 保存
    _save_profile(profile, output_dir, format)

    # 对比报告
    comparison = None
    if comparison_report and current_persona_path:
        comparison = _generate_comparison(profile, current_persona_path, output_dir)

    return profile


def _parse_dimension_text(dim_name: str, text: str) -> Dict:
    """
    尝试将 LLM 提取的文本解析为结构化数据。
    这是一个尽力而为的解析器，LLM 的输出格式可能不稳定。
    """
    structured: Dict = {}

    if dim_name == "catchphrases":
        structured = _parse_catchphrases(text)
    elif dim_name == "sentence_style":
        structured = _parse_sentence_style(text)
    elif dim_name == "stuttering":
        structured = _parse_stuttering(text)
    elif dim_name == "dialect":
        structured = _parse_dialect(text)
    elif dim_name == "audience_address":
        structured = _parse_audience_address(text)
    else:
        # 其他维度保留原始文本
        structured["summary"] = text.split("\n\n")[0] if text else ""

    return structured


def _parse_catchphrases(text: str) -> Dict:
    """解析口头禅列表"""
    phrases = []
    for line in text.split("\n"):
        match = re.match(
            r'[-*]\s*[""「](.+?)[""」]\s*[（(]?\s*频率[:：]?\s*(\d+)\s*次?[)）]?',
            line
        )
        if match:
            phrases.append({"phrase": match.group(1), "count": int(match.group(2))})
    return {"phrases": phrases, "total": len(phrases)}


def _parse_sentence_style(text: str) -> Dict:
    """解析句式特征"""
    return {"summary": text[:500] if text else ""}


def _parse_dialect(text: str) -> Dict:
    """解析方言特征"""
    words = []
    for line in text.split("\n"):
        match = re.match(
            r'[-*]\s*[""「](.+?)[""」]\s*[-–—]\s*(.+)',
            line
        )
        if match:
            words.append({"word": match.group(1), "meaning": match.group(2)})
    return {"words": words, "total": len(words)}


def _parse_audience_address(text: str) -> Dict:
    """解析称呼模式"""
    address_list = []
    for line in text.split("\n"):
        match = re.match(r'[-*]\s*(.+)', line)
        if match:
            address_list.append(match.group(1).strip())
    return {"address_terms": address_list, "total": len(address_list)}


def _parse_stuttering(text: str) -> Dict:
    """解析口吃/重复模式（支持 LLM 输出和规则引擎输出两种格式）"""
    patterns = []
    imitation_rules = []

    # ── 检测是否是规则引擎输出 ──
    if "规则提取结果" in text:
        # 规则引擎格式：解析「词」 - N次 - 上下文
        for match in re.finditer(
            r'[\u201c\u300c]([^\u201d\u300d]{2,10})[\u201d\u300d]\s*[-–—]\s*(\d+)\s*次',
            text
        ):
            word = match.group(1).strip()
            count = int(match.group(2))
            patterns.append({"word": word, "count": count})

        # 提取模仿建议
        for line in text.split('\n'):
            line = line.strip()
            if line.startswith('- ') and len(line) > 15:
                imitation_rules.append(line[2:])
    else:
        # LLM 格式
        for match in re.finditer(
            r'[\u201c\u300c]([^\u201d\u300d]{2,30})[\u201d\u300d]',
            text
        ):
            pat = match.group(1).strip()
            if pat and len(pat) >= 2:
                patterns.append({"word": pat, "count": 1})

    # 去重
    seen = set()
    unique = []
    for p in patterns:
        w = p.get("word", "")
        if w and w not in seen:
            seen.add(w)
            unique.append(p)

    return {
        "patterns": unique,
        "total_patterns": len(unique),
        "imitation_rules": imitation_rules,
    }


def _save_profile(profile: Dict, output_dir: Path, format: str):
    """保存编译后的人格配置"""
    if format == "json":
        path = output_dir / "persona_profile.json"
        with open(path, "w", encoding="utf-8") as f:
            json.dump(profile, f, ensure_ascii=False, indent=2)
    elif format == "yaml":
        import yaml
        path = output_dir / "persona_profile.yaml"
        with open(path, "w", encoding="utf-8") as f:
            yaml.dump(profile, f, allow_unicode=True, default_flow_style=False)
    elif format == "markdown":
        path = output_dir / "persona_profile.md"
        with open(path, "w", encoding="utf-8") as f:
            _write_markdown_profile(profile, f)
    else:
        path = output_dir / "persona_profile.json"
        with open(path, "w", encoding="utf-8") as f:
            json.dump(profile, f, ensure_ascii=False, indent=2)

    print(f"[compile] Profile saved: {path}")


def _write_markdown_profile(profile: Dict, f):
    """将 profile 写入 Markdown 格式"""
    f.write("# 元元人设蒸馏结果\n\n")
    f.write(f"> 版本: {profile['meta']['version']}\n")
    f.write(f"> 提取维度: {', '.join(profile['meta']['dimensions_extracted'])}\n\n")

    persona = profile.get("persona", {})
    for dim_name, dim_data in persona.items():
        f.write(f"## {dim_name}\n\n")
        if isinstance(dim_data, dict):
            raw = dim_data.get("raw", "")
            if raw:
                f.write(f"{raw}\n\n")
        else:
            f.write(f"{dim_data}\n\n")


def _generate_comparison(
    profile: Dict,
    current_persona_path: str,
    output_dir: Path,
) -> Optional[Dict]:
    """
    生成蒸馏结果 vs 当前 system prompt 的对比报告。
    当前实现为简化版：逐段对比文本差异。
    """
    current_path = Path(current_persona_path)
    if not current_path.exists():
        print(f"[compile] WARNING: Current persona not found at {current_path}, skip comparison")
        return None

    # 尝试读取当前 system prompt（从 JS 文件中提取）
    with open(current_path, "r", encoding="utf-8") as f:
        js_content = f.read()

    # 简单提取 systemPrompt 字符串（不解析 JS AST）
    match = re.search(r'systemPrompt:\s*["\']([^"\']{100,})["\']', js_content, re.DOTALL)
    current_prompt = match.group(1)[:500] if match else "（无法自动提取）"

    comparison = {
        "current_prompt_preview": current_prompt,
        "distilled_profile": {
            dim: data.get("raw", "")[:200]
            for dim, data in profile.get("persona", {}).items()
        },
        "notes": [
            "此对比报告仅展示蒸馏结果的预览片段",
            "完整对比需人工逐维度比对",
            "建议关注差异最大的维度优先优化",
        ],
    }

    comp_path = output_dir / "comparison_report.json"
    with open(comp_path, "w", encoding="utf-8") as f:
        json.dump(comparison, f, ensure_ascii=False, indent=2)
    print(f"[compile] Comparison report saved: {comp_path}")

    return comparison
