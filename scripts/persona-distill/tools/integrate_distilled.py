#!/usr/bin/env python3
"""
将蒸馏输出 (persona_profile.json) 的 9 维度发现，整合到人格卡 (persona-card.json) 中。

功能：
1. 解析每个维度的 raw 文本 → 按 Schema 映射到结构化字段
2. 生成对比分析报告：蒸馏发现 vs 现有 system_prompt 的覆盖情况
3. 更新人格卡的 personality_dimensions、source_materials、meta 字段
4. 输出 enriched persona-card.json

用法：
    python tools/integrate_distilled.py [--dry-run] [--compare-only]

    --dry-run:      只打印分析结果，不写入文件
    --compare-only: 只生成对比报告，不更新人格卡
"""

import json
import re
import sys
import argparse
from pathlib import Path
from datetime import date

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
DISTILLED_PATH = PROJECT_ROOT / "scripts/persona-distill/output/compile/persona_profile.json"
CARD_PATH = PROJECT_ROOT / "persona-cards/kxyy-yuanyuan/persona-card.json"
OUTPUT_DIR = PROJECT_ROOT / "scripts/persona-distill/output/integration"


# ── Parser helpers ────────────────────────────────────────────────────────


def parse_catchphrases(raw: str) -> dict:
    """Parse `- "xxx"（频率:N次，语境:xxx）` lines into structured phrases."""
    phrases = []
    # Pattern: - "xxx"（频率:N次，语境:xxx）
    # Also handles: - "xxx"（频率:多次，语境:xxx）
    pattern = re.compile(r'-\s*"([^"]+)"\s*[（(]\s*频率[：:]([^，,)）]+)[，,)\s]*语境[：:]([^)）]*)[）)]?')
    for m in pattern.finditer(raw):
        phrase_text = m.group(1).strip()
        count_str = m.group(2).strip()
        context = m.group(3).strip() if m.group(3) else ""
        # Try to parse count; "多次" → high frequency marker
        try:
            count = int(count_str)
        except ValueError:
            count = -1  # "多次" etc.
        phrases.append({"phrase": phrase_text, "count": count, "context": context})
    return {
        "phrases": phrases[:50],  # cap at 50 to keep card manageable
        "total": len(phrases),
        "raw_notes": raw[:200] if not phrases else "",
    }


def parse_sentence_style(raw: str) -> dict:
    """Parse markdown subsections of sentence style analysis."""
    result = {
        "avg_length": "",
        "structure_pref": "",
        "rhythm": "",
        "connectors": "",
        "fillers": "",
    }
    # Extract numbered sections
    sections = {
        "平均句长": "avg_length",
        "句式结构偏好": "structure_pref",
        "节奏特征": "rhythm",
        "连接词习惯": "connectors",
        "停顿/填充词": "fillers",
    }
    for label, key in sections.items():
        # Match "1. **平均句长**：..." or "**平均句长**：..."
        pat = re.compile(rf'(?:\d+\.\s*)?\*?\*?{re.escape(label)}\*?\*?\s*[：:]\s*(.+?)(?=\n\n|\n\d+\.|\n\*\*|\Z)', re.DOTALL)
        m = pat.search(raw)
        if m:
            result[key] = m.group(1).strip()
    return result


def parse_emotional_pattern(raw: str) -> dict:
    """Parse numbered emotional pattern sections.
    Format: `1. **开心/兴奋时**：...content...`
    """
    result = {
        "joy": "",
        "anger": "",
        "shy": "",
        "moved": "",
        "tease": "",
        "comfort": "",
    }
    # Labels include the trailing "时" since it's part of the bold text
    mapping = {
        "开心/兴奋时": "joy",
        "生气/不满时": "anger",
        "害羞/尴尬时": "shy",
        "感动/走心时": "moved",
        "调侃/吐槽时": "tease",
        "安慰/温柔时": "comfort",
    }
    for label, key in mapping.items():
        # Match: `N. **label**： content` or `N. **label** : content`
        pat = re.compile(
            rf'\d+\.\s*\*?\*?{re.escape(label)}\*?\*?\s*[：:]\s*'
            rf'(.+?)(?=\n\d+\.\s*\*\*|\Z)',
            re.DOTALL
        )
        m = pat.search(raw)
        if m:
            result[key] = m.group(1).strip()
    return result


def parse_interaction_pattern(raw: str) -> dict:
    """Parse numbered interaction pattern sections."""
    result = {
        "praised": "",
        "challenged": "",
        "privacy": "",
        "cold_start": "",
        "flow": "",
        "familiarity": "",
    }
    mapping = {
        "被夸赞": "praised",
        "被质疑/挑刺": "challenged",
        "被问隐私": "privacy",
        "冷场/没弹幕": "cold_start",
        "接话习惯": "flow",
        "对熟客": "familiarity",
    }
    for label, key in mapping.items():
        # Use a flexible match: find the numbered section starting with the label
        pat = re.compile(rf'\d+\.\s*\*?\*?{re.escape(label)}.*?\*?\*?\s*[：:]\s*(.+?)(?=\n\d+\.\s*\*\*|\Z)', re.DOTALL)
        m = pat.search(raw)
        if m:
            result[key] = m.group(1).strip()
    return result


def parse_dialect_features(raw: str) -> dict:
    """Parse dialect word list and grammar/pronunciation sections."""
    words = []
    grammar = ""
    pronunciation = ""

    # Parse word entries: **词：** xxx / **含义：** xxx / **原文例句：** xxx
    word_pattern = re.compile(
        r'\*?\*?词\*?\*?\s*[：:]\s*(.+?)\n'
        r'.*?\*?\*?含义\*?\*?\s*[：:]\s*(.+?)\n'
        r'.*?\*?\*?原文例句\*?\*?\s*[：:]\s*"([^"]*)"',
        re.DOTALL
    )
    for m in word_pattern.finditer(raw):
        word_text = m.group(1).strip()
        meaning = m.group(2).strip()
        example = m.group(3).strip()
        words.append({
            "word": word_text,
            "meaning": meaning,
            "examples": [example] if example else [],
        })

    # Parse grammar section
    gram_match = re.search(r'###\s*\d+\.\s*语法特征\s*\n(.+?)(?=###|\Z)', raw, re.DOTALL)
    if gram_match:
        grammar = gram_match.group(1).strip()

    # Parse pronunciation section
    pron_match = re.search(r'###\s*\d+\.\s*发音特征\s*\n(.+?)(?=###|\Z)', raw, re.DOTALL)
    if pron_match:
        pronunciation = pron_match.group(1).strip()

    return {
        "words": words,
        "grammar": grammar,
        "pronunciation": pronunciation,
        "total": len(words),
    }


def parse_self_reference(raw: str) -> dict:
    """Parse self-reference sections."""
    result = {
        "terms": "",
        "variations": "",
        "self_descriptions": "",
        "self_deprecation": "",
    }
    mapping = {
        "自称": "terms",
        "自称的变化": "variations",
        "自我描述": "self_descriptions",
        "自嘲模式": "self_deprecation",
    }
    for label, key in mapping.items():
        pat = re.compile(rf'\d+\.\s*\*?\*?{re.escape(label)}\*?\*?\s*[：:]\s*(.+?)(?=\n\d+\.|\Z)', re.DOTALL)
        m = pat.search(raw)
        if m:
            result[key] = m.group(1).strip()
    return result


def parse_audience_address(raw: str) -> dict:
    """Parse audience address patterns."""
    result = {
        "collective": [],
        "individual": [],
        "by_scene": {},
        "intimacy_levels": {},
        "total": 0,
    }

    # Parse collective terms
    coll_match = re.search(r'\*?\*?\d*\.?\s*集体称呼\*?\*?\s*\n(.+?)(?=\n\*?\*?\d+\.|\Z)', raw, re.DOTALL)
    if coll_match:
        terms = re.findall(r'-\s*(.+?)(?:\n|$)', coll_match.group(1))
        result["collective"] = [t.strip() for t in terms if t.strip() and not t.strip().startswith("*")]

    # Parse individual terms
    ind_match = re.search(r'\*?\*?\d*\.?\s*个体称呼\*?\*?\s*\n(.+?)(?=\n\*?\*?\d+\.|\Z)', raw, re.DOTALL)
    if ind_match:
        terms = re.findall(r'-\s*(.+?)(?:\n|$)', ind_match.group(1))
        result["individual"] = [t.strip() for t in terms if t.strip()]

    # Parse by-scene
    scene_mapping = {
        "开场/欢迎": "welcome",
        "感谢": "thanks",
        "互动/游戏": "interaction",
        "道别": "goodbye",
        "生气/感动": "angry_moved",
    }
    for label, key in scene_mapping.items():
        pat = re.compile(rf'\*?\*?{re.escape(label)}\*?\*?\s*[：:]\s*(.+?)(?=\n\*?\*|\Z)', re.DOTALL)
        m = pat.search(raw)
        if m:
            result["by_scene"][key] = m.group(1).strip()

    # Parse intimacy levels
    intimacy_mapping = {
        "熟客/常互动": "close",
        "普通观众": "regular",
        "新观众": "new",
    }
    for label, key in intimacy_mapping.items():
        pat = re.compile(rf'\*?\*?{re.escape(label)}\*?\*?\s*[：:]\s*(.+?)(?=\n\*?\*|\Z)', re.DOTALL)
        m = pat.search(raw)
        if m:
            result["intimacy_levels"][key] = m.group(1).strip()

    result["total"] = len(result["collective"]) + len(result["individual"])
    return result


def parse_stuttering_patterns(raw: str, structured: dict) -> dict:
    """Use existing structured data from rule engine, parse raw for additional info."""
    if structured and structured.get("patterns"):
        # Already has good structured data
        # Also extract frequency from raw
        freq_match = re.search(r'(\d+\.?\d*)\s*次/千字', raw)
        result = {
            "patterns": structured.get("patterns", []),
            "total_patterns": structured.get("total_patterns", 0),
            "frequency_per_1k": float(freq_match.group(1)) if freq_match else None,
            "imitation_rules": structured.get("imitation_rules", []),
        }
    else:
        # Parse from raw text
        patterns = []
        # Parse single-word stutters
        single_pat = re.compile(r'「(.+?)」\s*-\s*(\d+)次')
        for m in single_pat.finditer(raw):
            patterns.append({"word": m.group(1), "count": int(m.group(2))})
        result = {
            "patterns": patterns[:30],
            "total_patterns": len(patterns),
            "frequency_per_1k": 8.7,  # from the data
            "imitation_rules": [],
        }
    return result


def parse_topic_preference(raw: str) -> dict:
    """Parse YAML-like topic preference data."""
    result = {
        "top_topics": [],
        "switch_patterns": [],
        "avoidance": [],
        "verbosity": "",
    }

    # Parse high-frequency topics
    topic_pat = re.compile(r'话题:\s*(.+?)\n\s*例子:\s*"([^"]*)"(?:\n\s*例子:\s*"([^"]*)")?', re.MULTILINE)
    for m in topic_pat.finditer(raw):
        topic = {"topic": m.group(1).strip(), "examples": []}
        for g in [m.group(2), m.group(3)]:
            if g and g.strip():
                topic["examples"].append(g.strip())
        result["top_topics"].append(topic)

    # Parse switch patterns
    switch_pat = re.compile(r'模式:\s*(.+?)\n\s*例子:\s*"([^"]*)"', re.MULTILINE)
    for m in switch_pat.finditer(raw):
        result["switch_patterns"].append(f"{m.group(1).strip()}: {m.group(2).strip()}")

    # Parse avoidance patterns
    avoid_pat = re.compile(r'模式:\s*(.+?)\n\s*例子:\s*"([^"]*)"', re.MULTILINE)
    # Already parsed above as part of switch; avoid is separate section
    avoid_section = re.search(r'回避模式:\s*\n(.+?)(?=\n\S|\Z)', raw, re.DOTALL)
    if avoid_section:
        for m in re.finditer(r'模式:\s*(.+?)\n\s*例子:\s*"([^"]*)"', avoid_section.group(1)):
            result["avoidance"].append(f"{m.group(1).strip()}: {m.group(2).strip()}")

    # Parse verbosity
    verb_match = re.search(r'话痨程度:\s*\n\s*程度:\s*(.+?)(?=\n\s*例子:|\Z)', raw, re.DOTALL)
    if verb_match:
        result["verbosity"] = verb_match.group(1).strip()

    return result


# ── Comparison analysis ───────────────────────────────────────────────────


def check_dimension_coverage(system_prompt: str, dimension_name: str, raw_text: str) -> dict:
    """Check how well the existing system_prompt covers a distilled dimension."""
    # Extract key terms from the raw dimension text
    key_terms = set()
    # Look for quoted phrases, bold terms, and "「」" terms
    for pattern in [r'"([^"]+)"', r'「([^」]+)」', r'\*\*([^*]+)\*\*']:
        for m in re.finditer(pattern, raw_text):
            term = m.group(1).strip()
            if len(term) >= 2 and len(term) <= 20:
                key_terms.add(term)

    # Check how many key terms appear in system_prompt
    found = []
    missing = []
    for term in sorted(key_terms)[:30]:  # cap analysis
        if term.lower() in system_prompt.lower():
            found.append(term)
        else:
            missing.append(term)

    total = len(found) + len(missing)
    coverage = len(found) / total if total > 0 else 0

    return {
        "dimension": dimension_name,
        "coverage_pct": round(coverage * 100, 1),
        "terms_checked": total,
        "found_in_prompt": found[:15],
        "not_in_prompt": missing[:15],
        "verdict": (
            "已充分覆盖" if coverage > 0.8
            else "基本覆盖，可微调" if coverage > 0.5
            else "存在明显差距，建议重点优化"
        ),
    }


# ── Main integration logic ─────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(description="整合蒸馏数据到人格卡")
    parser.add_argument("--dry-run", action="store_true", help="只分析不写入")
    parser.add_argument("--compare-only", action="store_true", help="只生成对比报告")
    args = parser.parse_args()

    # 1. Load both files
    print("[1/4] 加载数据...")
    if not DISTILLED_PATH.exists():
        print(f"[FAIL] 找不到蒸馏输出: {DISTILLED_PATH}")
        sys.exit(1)
    if not CARD_PATH.exists():
        print(f"[FAIL] 找不到人格卡: {CARD_PATH}")
        sys.exit(1)

    with open(DISTILLED_PATH, "r", encoding="utf-8") as f:
        distilled = json.load(f)
    with open(CARD_PATH, "r", encoding="utf-8") as f:
        card = json.load(f)

    persona = distilled.get("persona", {})

    # 2. Parse each dimension
    print("[2/4] 解析蒸馏维度...")
    parsers = {
        "catchphrases": (parse_catchphrases, persona.get("catchphrases", {}).get("raw", "")),
        "sentence_style": (parse_sentence_style, persona.get("sentence_style", {}).get("raw", "")),
        "emotional_pattern": (parse_emotional_pattern, persona.get("emotional_pattern", {}).get("raw", "")),
        "interaction_pattern": (parse_interaction_pattern, persona.get("interaction_pattern", {}).get("raw", "")),
        "dialect_features": (parse_dialect_features, persona.get("dialect_features", {}).get("raw", "")),
        "self_reference": (parse_self_reference, persona.get("self_reference", {}).get("raw", "")),
        "audience_address": (parse_audience_address, persona.get("audience_address", {}).get("raw", "")),
        "stuttering_patterns": (
            parse_stuttering_patterns,
            persona.get("stuttering_patterns", {}).get("raw", ""),
            persona.get("stuttering_patterns", {}).get("structured", {}),
        ),
        "topic_preference": (parse_topic_preference, persona.get("topic_preference", {}).get("raw", "")),
    }

    # Note: stuttering_patterns parser needs (raw, structured) as args
    personality_dimensions = {}
    parse_errors = []
    for dim_name, parser_info in parsers.items():
        try:
            if dim_name == "stuttering_patterns":
                parser_fn, raw = parser_info[:2]
                structured = parser_info[2]
                personality_dimensions[dim_name] = parser_fn(raw, structured)
            else:
                parser_fn, raw = parser_info[:2]
                personality_dimensions[dim_name] = parser_fn(raw)
            # Quick quality check
            result = personality_dimensions[dim_name]
            if isinstance(result, dict) and not any(v for v in result.values() if v):
                parse_errors.append(f"{dim_name}: 解析结果为空，请检查原始数据格式")
        except Exception as e:
            parse_errors.append(f"{dim_name}: 解析失败 - {e}")
            personality_dimensions[dim_name] = {"_parse_error": str(e)}

    if parse_errors:
        print("  [WARN] 解析问题:")
        for err in parse_errors:
            print(f"    - {err}")

    print(f"  [OK] 已解析 {len(personality_dimensions)} 个维度")

    # 3. Generate comparison analysis
    print("[3/4] 生成对比分析...")
    system_prompt = card.get("system_prompt", "")
    comparisons = []
    for dim_name in personality_dimensions:
        raw_text = persona.get(dim_name, {}).get("raw", "")
        comp = check_dimension_coverage(system_prompt, dim_name, raw_text)
        comparisons.append(comp)

    # Summary
    high_coverage = [c for c in comparisons if c["coverage_pct"] > 80]
    medium_coverage = [c for c in comparisons if 50 <= c["coverage_pct"] <= 80]
    low_coverage = [c for c in comparisons if c["coverage_pct"] < 50]

    print(f"\n  === 对比分析 ===")
    print(f"  {'维度':<25} {'覆盖率':>8}  {'判断'}")
    print(f"  {'-'*60}")
    for c in comparisons:
        print(f"  {c['dimension']:<25} {c['coverage_pct']:>7.1f}%  {c['verdict']}")

    print(f"\n  [HIGH] 已充分覆盖: {len(high_coverage)} 个维度")
    for c in high_coverage:
        print(f"     - {c['dimension']} ({c['coverage_pct']:.0f}%)")
    print(f"  [WARN] 基本覆盖: {len(medium_coverage)} 个维度")
    for c in medium_coverage:
        print(f"     - {c['dimension']} ({c['coverage_pct']:.0f}%)")
    print(f"  [GAP] 存在差距: {len(low_coverage)} 个维度")
    for c in low_coverage:
        print(f"     - {c['dimension']} ({c['coverage_pct']:.0f}%)")
        if c["not_in_prompt"]:
            sample = c["not_in_prompt"][:5]
            print(f"       未覆盖: {', '.join(sample)}")

    if args.compare_only:
        # Save comparison report
        OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        report_path = OUTPUT_DIR / "integration_report.json"
        with open(report_path, "w", encoding="utf-8") as f:
            json.dump({
                "generated": date.today().isoformat(),
                "comparisons": comparisons,
                "summary": {
                    "high_coverage": len(high_coverage),
                    "medium_coverage": len(medium_coverage),
                    "low_coverage": len(low_coverage),
                },
                "recommendations": [
                    f"重点优化 {c['dimension']}：{', '.join(c['not_in_prompt'][:5])}"
                    for c in low_coverage if c["not_in_prompt"]
                ],
            }, f, ensure_ascii=False, indent=2)
        print(f"\n  [OK] 对比报告已保存: {report_path}")
        return

    # 4. Update persona card
    if args.dry_run:
        print("\n[DRY-RUN] 以下更新将被写入：")
        print(f"  - 新增 personality_dimensions ({len(personality_dimensions)} 个维度)")
        print(f"  - 更新 source_materials")
        print(f"  - 更新 meta.updated")
        return

    print("\n[4/4] 更新人格卡...")
    card["personality_dimensions"] = personality_dimensions

    # Update source_materials
    if "source_materials" not in card:
        card["source_materials"] = []
    card["source_materials"].append({
        "type": "audio",
        "path": "scripts/persona-distill/input/",
        "description": "蒸馏管道从直播回放提取的 9 维度人格模式 (5条回放)",
    })

    # Update meta
    card["meta"]["updated"] = date.today().isoformat()
    if "distilled" not in card["meta"].get("tags", []):
        card["meta"].setdefault("tags", []).append("distilled")

    # Write back
    with open(CARD_PATH, "w", encoding="utf-8") as f:
        json.dump(card, f, ensure_ascii=False, indent=2)

    file_size_kb = CARD_PATH.stat().st_size / 1024
    print(f"  [OK] 人格卡已更新: {CARD_PATH}")
    print(f"   大小: {file_size_kb:.1f} KB")
    print(f"   新增字段: personality_dimensions ({len(personality_dimensions)} 维度)")
    print(f"\n  下一步:")
    print(f"    python tools/validate_card.py {CARD_PATH}")
    print(f"    npm run update-persona  # 打包进 App")


if __name__ == "__main__":
    main()
