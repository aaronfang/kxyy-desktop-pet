#!/usr/bin/env python3
"""规则引擎提取口吃模式（确定性，无 LLM 幻觉）"""
import re
import json
from pathlib import Path
from collections import Counter
from typing import Dict, List


def extract_stuttering_patterns(text: str) -> Dict:
    """
    用正则规则从转录文本中提取口吃/重复模式。
    返回结构化结果，后续可由 LLM 汇总分析。
    """
    patterns = []
    
    # ── 1. 单字叠字（连续 3 个以上相同汉字）──
    # 例如: 我我我、行行行、对对对
    single_repeats = re.findall(r'([\u4e00-\u9fff])\1{2,}', text)
    single_counter = Counter()
    for match in re.finditer(r'([\u4e00-\u9fff])\1{2,}', text):
        word = match.group(1)
        rep = match.group(0)
        single_counter[word] += 1
        # 获取上下文
        start = max(0, match.start() - 15)
        end = min(len(text), match.end() + 15)
        ctx = text[start:end].replace('\n', ' ')
        patterns.append({
            "type": "单字叠字",
            "pattern": rep,
            "char": word,
            "repeat_count": len(rep),
            "context": ctx,
        })
    
    # ── 2. 双字词语重复（连续重复相同的 2 字词）──
    # 例如: 就是就是、那个那个、没有没有
    word_repeats = Counter()
    for match in re.finditer(r'([\u4e00-\u9fff]{2})\1{1,}', text):
        word = match.group(1)
        rep = match.group(0)
        word_repeats[word] += 1
        start = max(0, match.start() - 15)
        end = min(len(text), match.end() + 15)
        ctx = text[start:end].replace('\n', ' ')
        patterns.append({
            "type": "词语重复",
            "pattern": rep,
            "word": word,
            "repeat_count": len(rep) // len(word),
            "context": ctx,
        })
    
    # ── 3. 短语重复（同一短语在短窗口内出现多次）──
    # 例如: 我跟你说我跟你说
    for match in re.finditer(r'([\u4e00-\u9fff，。！？\s]{4,12})\1', text):
        phrase = match.group(1).strip()
        if len(phrase) < 6:
            continue  # skip short phrases that overlap with word repeats
        # 只保留合理的中文短语（至少包含一个标点或实质内容）
        if re.search(r'[\u4e00-\u9fff]{3,}', phrase):
            rep = match.group(0)
            start = max(0, match.start() - 10)
            end = min(len(text), match.end() + 10)
            ctx = text[start:end].replace('\n', ' ')
            patterns.append({
                "type": "短语重复",
                "pattern": rep,
                "phrase": phrase,
                "context": ctx,
            })
    
    # ── 统计摘要 ──
    stats = {
        "total_repetitions": len(patterns),
        "single_char_top": single_counter.most_common(15),
        "word_repeat_top": word_repeats.most_common(15),
        "by_type": {
            "单字叠字": sum(1 for p in patterns if p["type"] == "单字叠字"),
            "词语重复": sum(1 for p in patterns if p["type"] == "词语重复"),
            "短语重复": sum(1 for p in patterns if p["type"] == "短语重复"),
        },
    }
    
    return {
        "stats": stats,
        "patterns": patterns,
    }


def main():
    import sys, io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
    
    transcript_path = Path(__file__).parent / "output/transcript_cleaned/260606-开心元元直播录屏分享26年6月5日-p01_yuanyuan.txt"
    text = transcript_path.read_text(encoding='utf-8')
    
    result = extract_stuttering_patterns(text)
    
    print(f"文本长度: {len(text)} chars")
    print(f"发现重复: {result['stats']['total_repetitions']} 处")
    print(f"  单字叠字: {result['stats']['by_type']['单字叠字']}")
    print(f"  词语重复: {result['stats']['by_type']['词语重复']}")
    print(f"  短语重复: {result['stats']['by_type']['短语重复']}")
    print()
    
    print("=== 高频单字叠字 Top 10 ===")
    for char, count in result['stats']['single_char_top'][:10]:
        print(f"  {char}: {count}次")
    
    print()
    print("=== 高频词语重复 Top 10 ===")  
    for word, count in result['stats']['word_repeat_top'][:10]:
        print(f"  {word}: {count}次")
    
    print()
    print("=== 示例（每类 5 条）===")
    for stype in ["单字叠字", "词语重复", "短语重复"]:
        examples = [p for p in result["patterns"] if p["type"] == stype]
        print(f"\n--- {stype} ({len(examples)} 条) ---")
        for ex in examples[:5]:
            ctx = ex['context'][:80]
            print(f"  [{ex['pattern']}] ...{ctx}...")
    
    # 输出到文件
    out_path = Path(__file__).parent / "output/distillation/stuttering_raw.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    print(f"\n结果已保存: {out_path}")


if __name__ == "__main__":
    main()
