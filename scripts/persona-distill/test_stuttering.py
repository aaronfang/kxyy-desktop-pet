#!/usr/bin/env python3
"""快速验证 stuttering 维度提取"""
import sys, io, json
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

from pathlib import Path
from steps.distill import load_extraction_prompts, create_engine, extract_dimension

root = Path(__file__).parent
config = {
    "engine": "ollama",
    "ollama": {"model": "qwen3:14b", "host": "http://127.0.0.1:11434"},
    "temperature": 0.3, "top_p": 0.9,
}

# 加载 prompt
prompts = load_extraction_prompts(root / "prompts")
st_config = prompts.get("stuttering", {})

# 只取前 3000 chars 测试
txt = Path("output/transcript_cleaned/260606-开心元元直播录屏分享26年6月5日-p01_yuanyuan.txt").read_text(encoding='utf-8')
test_text = txt[:3000]

print(f"Testing stuttering extraction on {len(test_text)} chars...")
print("-" * 60)

engine = create_engine(config)
result = extract_dimension(
    engine, "stuttering", st_config,
    test_text,
    chunk_chars=6000, chunk_overlap=500,
    llm_temp=0.3, llm_top_p=0.9,
    prompts=prompts,
)

print(result)
print("-" * 60)
print(f"Output length: {len(result)} chars")
