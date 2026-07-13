"""
Step 4: LLM 人设蒸馏提取
使用本地/云端 LLM 从转录文本中提取人格模式。

支持引擎:
- llama.cpp (GGUF 模型，本地)
- Ollama (本地模型)
- deepseek (DeepSeek API，云端，OpenAI 兼容协议)

提取 9 个维度（定义在 prompts/extraction.yaml）:
  1. catchphrases    - 口头禅与高频词汇
  2. sentence_style  - 句式特征
  3. stuttering      - 口吃与重复模式
  4. emotional_pattern - 情感表达模式
  5. interaction     - 互动回应模式
  6. dialect         - 方言/口音特征
  7. self_reference  - 自我指称方式
  8. audience_address - 对粉丝的称呼模式
  9. topic_preference - 话题偏好
"""

import json
import os
import re
from pathlib import Path
from typing import Dict, List, Optional, Callable

import yaml


# ---------------------------------------------------------------------------
# Prompt 加载
# ---------------------------------------------------------------------------

def load_extraction_prompts(prompts_dir: Path) -> Dict:
    """加载 YAML 格式的提取提示词"""
    yaml_path = prompts_dir / "extraction.yaml"
    with open(yaml_path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


# ---------------------------------------------------------------------------
# LLM 引擎
# ---------------------------------------------------------------------------

class LlamaCppEngine:
    """llama-cpp-python 引擎"""

    def __init__(self, model_path: Path, n_ctx: int, n_gpu_layers: int, n_threads: int):
        self.model_path = model_path
        self.n_ctx = n_ctx
        self.n_gpu_layers = n_gpu_layers
        self.n_threads = n_threads

    def generate(self, prompt: str, temperature: float = 0.3, top_p: float = 0.9) -> str:
        from llama_cpp import Llama

        llm = Llama(
            model_path=str(self.model_path),
            n_ctx=self.n_ctx,
            n_gpu_layers=self.n_gpu_layers,
            n_threads=self.n_threads,
            verbose=False,
        )

        output = llm.create_chat_completion(
            messages=[
                {"role": "user", "content": prompt}
            ],
            temperature=temperature,
            top_p=top_p,
            max_tokens=2048,
        )

        content = output["choices"][0]["message"]["content"]
        return content.strip()


class OllamaEngine:
    """Ollama 引擎"""

    def __init__(self, model: str, host: str):
        self.model = model
        self.host = host

    def generate(self, prompt: str, temperature: float = 0.3, top_p: float = 0.9) -> str:
        import urllib.request

        url = f"{self.host}/api/chat"
        data = json.dumps({
            "model": self.model,
            "messages": [{"role": "user", "content": prompt}],
            "stream": False,
            "options": {
                "temperature": temperature,
                "top_p": top_p,
                "num_predict": 4096,
                # 禁用 thinking/reasoning 模式，避免模型自行转向"润色"
                "enable_thinking": False,
            },
        }).encode("utf-8")

        req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=300) as resp:
            result = json.loads(resp.read())
        return result["message"]["content"].strip()


class DeepSeekEngine:
    """DeepSeek API 引擎 (OpenAI 兼容协议)"""

    def __init__(self, api_key: str, model: str = "deepseek-chat",
                 base_url: str = "https://api.deepseek.com",
                 frequency_penalty: float = 0.0):
        self.api_key = api_key
        self.model = model
        self.base_url = base_url.rstrip("/")
        self.frequency_penalty = frequency_penalty

    def generate(self, prompt: str, temperature: float = 0.3, top_p: float = 0.9,
                 frequency_penalty: float = None) -> str:
        import urllib.request
        import urllib.error

        # Allow per-call override of frequency_penalty
        fp = frequency_penalty if frequency_penalty is not None else self.frequency_penalty

        url = f"{self.base_url}/v1/chat/completions"
        payload = {
            "model": self.model,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": temperature,
            "max_tokens": 4096,
            "stream": False,
        }
        if fp > 0:
            payload["frequency_penalty"] = fp
        data = json.dumps(payload).encode("utf-8")

        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.api_key}",
        }

        max_retries = 3
        for attempt in range(max_retries):
            try:
                req = urllib.request.Request(url, data=data, headers=headers, method="POST")
                with urllib.request.urlopen(req, timeout=180) as resp:
                    result = json.loads(resp.read())
                return result["choices"][0]["message"]["content"].strip()
            except urllib.error.HTTPError as e:
                body = e.read().decode("utf-8", errors="replace")
                if attempt < max_retries - 1:
                    wait = 2 ** attempt
                    print(f"  [deepseek] HTTP {e.code}, retry in {wait}s... ({body[:200]})")
                    import time
                    time.sleep(wait)
                else:
                    raise RuntimeError(
                        f"DeepSeek API error {e.code}: {body[:500]}"
                    ) from e
            except (urllib.error.URLError, OSError) as e:
                if attempt < max_retries - 1:
                    wait = 2 ** attempt
                    print(f"  [deepseek] Network error, retry in {wait}s... ({e})")
                    import time
                    time.sleep(wait)
                else:
                    raise


def create_engine(config: Dict) -> Callable:
    """根据配置创建 LLM 引擎"""
    engine_type = config.get("engine", "llama.cpp")

    if engine_type == "llama.cpp":
        cfg = config.get("llama_cpp", {})
        model_path = cfg.get("model_path")
        if not model_path or not Path(model_path).exists():
            raise FileNotFoundError(
                f"GGUF model not found: {model_path}\n"
                f"Please download a Qwen3 model (e.g., Qwen3-14B-Q4_K_M.gguf) "
                f"and set distill.llama_cpp.model_path in config.yaml"
            )
        engine = LlamaCppEngine(
            model_path=Path(model_path),
            n_ctx=cfg.get("n_ctx", 32768),
            n_gpu_layers=cfg.get("n_gpu_layers", -1),
            n_threads=cfg.get("n_threads", 8),
        )
    elif engine_type == "ollama":
        cfg = config.get("ollama", {})
        engine = OllamaEngine(
            model=cfg.get("model", "qwen3:14b"),
            host=cfg.get("host", "http://127.0.0.1:11434"),
        )
    elif engine_type == "deepseek":
        cfg = config.get("deepseek", {})
        api_key = cfg.get("api_key") or os.environ.get("DEEPSEEK_API_KEY")
        if not api_key:
            raise ValueError(
                "DeepSeek API key not found.\n"
                "  Set DEEPSEEK_API_KEY environment variable, or\n"
                "  add api_key to distill.deepseek in config.yaml"
            )
        engine = DeepSeekEngine(
            api_key=api_key,
            model=cfg.get("model", "deepseek-chat"),
            base_url=cfg.get("base_url", "https://api.deepseek.com"),
            frequency_penalty=cfg.get("frequency_penalty", 0.15),
        )
    else:
        raise ValueError(f"Unknown LLM engine: {engine_type}")

    return engine


# ---------------------------------------------------------------------------
# 文本分块
# ---------------------------------------------------------------------------

def chunk_text(text: str, max_chars: int = 6000, overlap: int = 500) -> List[str]:
    """
    将长文本分块，保持句子完整性。

    Args:
        text: 输入文本
        max_chars: 每块最大字符数
        overlap: 块间重叠字符数

    Returns:
        List[str]: 文本块列表
    """
    if len(text) <= max_chars:
        return [text]

    chunks = []
    sentences = re.split(r'(?<=[。！？\n])', text)
    current = ""
    for sent in sentences:
        if len(current) + len(sent) > max_chars:
            if current:
                chunks.append(current.strip())
            # Start new chunk with overlap from previous
            if chunks and overlap > 0:
                prev = chunks[-1]
                overlap_text = prev[-overlap:] if len(prev) > overlap else prev
                current = overlap_text + sent
            else:
                current = sent
        else:
            current += sent

    if current.strip():
        chunks.append(current.strip())

    print(f"[distill] Split text ({len(text)} chars) into {len(chunks)} chunks")
    return chunks


def _clean_dialect(text: str) -> str:
    """方言特征后处理：过滤无效行（长行、未出现条目等）。

    多 chunk 场景下不做代码级去重（LLM 输出格式多变），
    交给 downstream compile 步骤处理。
    """
    lines = text.splitlines()
    cleaned = []
    for line in lines:
        stripped = line.strip()
        if not stripped:
            cleaned.append(line)
            continue
        # 跳过 LLM 输出崩溃：超长行通常是原始文本误入
        if len(stripped) > 800:
            continue
        # 跳过 "未出现" 类条目
        if any(kw in stripped for kw in ["未直接出现", "未出现", "疑似未出现"]):
            continue
        # 跳过 "原文例句：无" 的空洞条目
        if "原文例句：无" in stripped or "原文例句: 无" in stripped:
            continue
        cleaned.append(line)
    return "\n".join(cleaned)


# ---------------------------------------------------------------------------
# 后处理：清洗 LLM 输出中的幻觉和冗余
# ---------------------------------------------------------------------------

def _clean_result(dim_name: str, text: str) -> str:
    """对特定维度的 LLM 输出进行后处理过滤。

    - dialect: 代码级去重合并（多 chunk 场景），过滤长行和无效条目
    - catchphrases: 移除连续重复行
    - audience_address: 检测 LLM 输出崩溃（连续重复同一行超过阈值），截断保留有效部分
    - emotional_pattern: 不做代码级处理（靠 prompt 约束）
    """
    if dim_name == "dialect":
        return _clean_dialect(text)

    if dim_name == "catchphrases":
        lines = text.splitlines()
        seen = set()
        cleaned = []
        for line in lines:
            stripped = line.strip()
            if not stripped:
                cleaned.append(line)
                continue
            # 对以 - " 开头的条目行去重
            if stripped.startswith('- "') or stripped.startswith('-「'):
                if stripped in seen:
                    continue
                seen.add(stripped)
            cleaned.append(line)
        return "\n".join(cleaned)

    if dim_name in ("audience_address",):
        # 检测 LLM 输出崩溃：同一行连续重复超过 4 次 → 从第一次出现处截断
        lines = text.splitlines()
        cleaned = []
        repeat_count = 0
        last_line = None
        for line in lines:
            stripped = line.strip()
            if stripped and stripped == last_line:
                repeat_count += 1
                if repeat_count > 4:
                    # 连续重复超过 4 次，标记截断点
                    cleaned.append(f"\n[OUTPUT TRUNCATED: LLM collapsed, repeated line '{stripped[:50]}...' {repeat_count}+ times]")
                    break
            else:
                repeat_count = 0
            last_line = stripped
            cleaned.append(line)
        return "\n".join(cleaned)

    return text


# ---------------------------------------------------------------------------
# 单个维度提取
# ---------------------------------------------------------------------------

def extract_dimension(
    engine,
    dim_name: str,
    dim_config: Dict,
    transcript_text: str,
    chunk_chars: int,
    chunk_overlap: int,
    llm_temp: float,
    llm_top_p: float,
    prompts: Dict,
    freq_penalty: float = 0.15,
) -> str:
    """
    对单个维度进行提取，可能涉及多块 + 合并。

    Args:
        engine: LLM 引擎实例
        dim_name: 维度名
        dim_config: 维度配置（含 prompt 和 merge prompt）
        transcript_text: 转录文本
        freq_penalty: frequency_penalty 参数（防输出崩溃重复）
        ...

    Returns:
        str: 该维度的提取结果
    """
    prompt_template = dim_config.get("prompt", "")
    merge_config = prompts.get(f"{dim_name}_merge", {})
    merge_prompt = merge_config.get("prompt", "") if isinstance(merge_config, dict) else ""
    dim_label = dim_config.get("name", dim_name)

    print(f"\n[distill] Extracting dimension: {dim_label} ({dim_name})")

    # 通用约束：禁止改写，严格按格式输出提取结果
    _DO_NOT_REWRITE = (
        '> SYSTEM: You are a data extraction tool, not a text editor. '
        'Do NOT rewrite, polish, summarize, or optimize the input text. '
        'Output ONLY the requested structured data in the specified format. '
        'Never output markdown headings like "润色版" "优化版" "整理版".\n\n'
    )

    # 分块
    chunks = chunk_text(transcript_text, chunk_chars, chunk_overlap)

    if len(chunks) == 1:
        # 单块直接提取
        prompt = _DO_NOT_REWRITE + prompt_template.replace("{chunk}", chunks[0])
        result = engine.generate(
            prompt, temperature=llm_temp, top_p=llm_top_p, frequency_penalty=freq_penalty,
        )
        return result

    # 多块：逐块提取 -> 合并
    chunk_results = []
    for i, chunk in enumerate(chunks):
        print(f"  chunk {i + 1}/{len(chunks)} ({len(chunk)} chars)")
        prompt = _DO_NOT_REWRITE + prompt_template.replace("{chunk}", chunk)
        try:
            result = engine.generate(
                prompt, temperature=llm_temp, top_p=llm_top_p, frequency_penalty=freq_penalty,
            )
            chunk_results.append(result)
        except Exception as e:
            print(f"  ERROR on chunk {i + 1}: {e}")
            chunk_results.append(f"[Extraction failed: {e}]")

    # 合并
    if merge_prompt:
        merge_input = "\n\n---\n\n".join(
            f"片段 {i + 1}:\n{r}" for i, r in enumerate(chunk_results)
        )
        merge_prompt_full = _DO_NOT_REWRITE + merge_prompt.replace("{chunk}", merge_input)
        try:
            # merge 阶段用稍高的 freq_penalty 防止合并时卡死重复
            merge_fp = max(freq_penalty, 0.3)
            merged = engine.generate(
                merge_prompt_full, temperature=llm_temp, top_p=llm_top_p,
                frequency_penalty=merge_fp,
            )
            return merged
        except Exception as e:
            print(f"  ERROR during merge: {e}")
            return "\n\n---\n\n".join(chunk_results)

    return "\n\n---\n\n".join(chunk_results)


# ---------------------------------------------------------------------------
# 规则引擎：口吃提取
# ---------------------------------------------------------------------------

def _extract_stuttering_by_rule(
    text: str, engine, dim_name: str, dim_config: Dict,
    prompts: Dict, llm_temp: float, llm_top_p: float,
) -> tuple:
    """
    用正则规则 + 可选 LLM 汇总做口吃提取。
    返回 (result_text, rule_data_dict)
    """
    import re
    from collections import Counter

    dim_label = dim_config.get("name", dim_name)
    print(f"\n[distill] Extracting dimension: {dim_label} ({dim_name}) [RULE ENGINE]")

    patterns = []

    # 1. 单字叠字（连续 3+ 个相同汉字）
    for match in re.finditer(r'([\u4e00-\u9fff])\1{2,}', text):
        word = match.group(1)
        rep = match.group(0)
        start = max(0, match.start() - 12)
        end = min(len(text), match.end() + 12)
        ctx = text[start:end].replace('\n', ' ')
        patterns.append({
            "type": "单字叠字",
            "char": word,
            "repeat": len(rep),
            "pattern": rep,
            "context": ctx,
        })

    # 2. 词语重复（连续重复同一 2 字词）
    for match in re.finditer(r'([\u4e00-\u9fff]{2})\1{1,}', text):
        word = match.group(1)
        rep = match.group(0)
        start = max(0, match.start() - 12)
        end = min(len(text), match.end() + 12)
        ctx = text[start:end].replace('\n', ' ')
        patterns.append({
            "type": "词语重复",
            "word": word,
            "repeat": len(rep) // len(word),
            "pattern": rep,
            "context": ctx,
        })

    # 3. 短语重复
    for match in re.finditer(r'([\u4e00-\u9fff，。！？、\s]{4,16})\1', text):
        phrase = match.group(1).strip()
        if len(phrase) < 6 or not re.search(r'[\u4e00-\u9fff]{3,}', phrase):
            continue
        rep = match.group(0)
        start = max(0, match.start() - 8)
        end = min(len(text), match.end() + 8)
        ctx = text[start:end].replace('\n', ' ')
        patterns.append({
            "type": "短语重复",
            "phrase": phrase,
            "pattern": rep,
            "context": ctx,
        })

    # 统计
    single_counter = Counter()
    word_counter = Counter()
    for p in patterns:
        if p["type"] == "单字叠字":
            single_counter[p["char"]] += 1
        elif p["type"] == "词语重复":
            word_counter[p["word"]] += 1

    # 生成文本结果（供下游 compile 使用）
    lines = []
    lines.append(f"## 口吃模式规则提取结果")
    lines.append(f"总计: {len(patterns)} 处重复")
    lines.append(f"  单字叠字: {sum(1 for p in patterns if p['type'] == '单字叠字')}")
    lines.append(f"  词语重复: {sum(1 for p in patterns if p['type'] == '词语重复')}")
    lines.append(f"  短语重复: {sum(1 for p in patterns if p['type'] == '短语重复')}")
    lines.append("")

    lines.append("### 高频单字叠字 Top 10")
    for char, cnt in single_counter.most_common(10):
        examples = [p for p in patterns if p["type"] == "单字叠字" and p["char"] == char]
        ex = examples[0]["context"][:60] if examples else ""
        lines.append(f"- 「{char * 3}」 - {cnt}次 - ...{ex}...")
    lines.append("")

    lines.append("### 高频词语重复 Top 10")
    for word, cnt in word_counter.most_common(10):
        examples = [p for p in patterns if p["type"] == "词语重复" and p["word"] == word]
        ex = examples[0]["context"][:60] if examples else ""
        lines.append(f"- 「{word}{word}」 - {cnt}次 - ...{ex}...")
    lines.append("")

    lines.append("### 短语重复")
    phrase_patterns = [p for p in patterns if p["type"] == "短语重复"]
    for p in phrase_patterns:
        lines.append(f"- 「{p['phrase']}」 - ...{p['context'][:60]}...")
    lines.append("")

    lines.append("### AI 模仿建议")
    if single_counter:
        top_char = single_counter.most_common(1)[0][0]
        top_count = single_counter.most_common(1)[0][1]
        lines.append(f"- 句首代词叠字特征明显，最常见「{top_char}{top_char}{top_char}」(出现{top_count}次)")
    if word_counter:
        top_word = word_counter.most_common(1)[0][0]
        lines.append(f"- 填充词重复显著，「{top_word}{top_word}」出现{word_counter.most_common(1)[0][1]}次，可在紧张/解释时触发")
    total = len(patterns)
    text_len = len(text.replace('\n', ''))
    freq_pct = total / max(1, text_len) * 1000
    lines.append(f"- 整体口吃频率约 {freq_pct:.1f} 次/千字，属于轻度自然口吃特征")

    result_text = "\n".join(lines)

    # ── 可选：LLM 汇总多个 chunk 的结果 ──
    # 这里文本较小，单次规则提取即可；如果将来需要多 chunk 再启用 LLM merge
    rule_data = {
        "patterns": patterns,
        "single_char_top": single_counter.most_common(15),
        "word_repeat_top": word_counter.most_common(15),
        "stats": {
            "total": len(patterns),
            "single_char": sum(1 for p in patterns if p["type"] == "单字叠字"),
            "word_repeat": sum(1 for p in patterns if p["type"] == "词语重复"),
            "phrase_repeat": sum(1 for p in patterns if p["type"] == "短语重复"),
        },
    }

    return result_text, rule_data


# ---------------------------------------------------------------------------
# 主蒸馏流程
# ---------------------------------------------------------------------------

def distill_persona(
    transcript_dir: Path,
    output_dir: Path,
    prompts_dir: Path,
    config: Dict,
) -> Dict:
    """
    执行完整的人格蒸馏提取。

    从 transcription 目录读取所有 .txt 文件，
    合并文本后对每个维度调用 LLM 提取。

    Returns:
        Dict: 所有维度的提取结果
    """
    output_dir.mkdir(parents=True, exist_ok=True)

    # 加载提取提示词
    prompts = load_extraction_prompts(prompts_dir)
    # 维度配置优先级：distill.dimensions > 过滤 merge prompt > 所有 key
    dimension_names = config.get("dimensions") or [
        k for k in prompts if not k.endswith("_merge")
    ]

    # 创建 LLM 引擎
    distill_cfg = config.get("distill", {})
    engine = create_engine(distill_cfg)
    llm_temp = distill_cfg.get("temperature", 0.3)
    llm_top_p = distill_cfg.get("top_p", 0.9)
    chunk_chars = distill_cfg.get("chunk_chars", 6000)
    chunk_overlap = distill_cfg.get("chunk_overlap", 500)
    freq_penalty = distill_cfg.get("frequency_penalty", 0.15)

    # 合并所有转录文本
    txt_files = sorted(transcript_dir.glob("*.txt"))
    if not txt_files:
        raise FileNotFoundError(f"No .txt files found in {transcript_dir}")

    all_texts = []
    for txt_file in txt_files:
        with open(txt_file, "r", encoding="utf-8") as f:
            text = f.read().strip()
            if text:
                all_texts.append(f"# {txt_file.stem}\n\n{text}")

    combined_text = "\n\n---\n\n".join(all_texts)
    total_chars = sum(len(t) for t in all_texts)
    print(f"[distill] Combined {len(txt_files)} transcripts: {total_chars} chars total")

    # ── stuttering 维度：规则引擎提取（确定性，无 LLM 幻觉）──
    rule_based_dimensions = {"stuttering"}  # 可扩展
    rule_results = {}  # 规则引擎结果，后续可喂给 LLM merge

    # 逐维度提取（支持缓存：已保存的维度跳过重跑）
    results = {}
    for dim_name in dimension_names:
        dim_config = prompts.get(dim_name)
        if not dim_config:
            print(f"[distill] WARNING: Unknown dimension '{dim_name}', skipping")
            continue

        # 检查缓存
        dim_cache_path = output_dir / f"{dim_name}.txt"
        if dim_cache_path.exists():
            print(f"[distill] Cached: {dim_name} -> {dim_cache_path}")
            cached_result = dim_cache_path.read_text(encoding="utf-8")
            entry = {
                "name": dim_config.get("name", dim_name),
                "raw_result": cached_result,
            }
            # 规则引擎维度也尝试从缓存重建
            if dim_name in rule_based_dimensions:
                # 规则引擎结果无法从 txt 反序列化，但 compile 可以从 raw_result 工作
                entry["rule_data"] = None
            results[dim_name] = entry
            continue

        try:
            if dim_name in rule_based_dimensions:
                # ── 规则引擎提取 ──
                result, rule_data = _extract_stuttering_by_rule(
                    combined_text, engine, dim_name, dim_config,
                    prompts, llm_temp, llm_top_p,
                )
                rule_results[dim_name] = rule_data
            else:
                # ── LLM 提取 ──
                result = extract_dimension(
                    engine, dim_name, dim_config,
                    combined_text,
                    chunk_chars, chunk_overlap,
                    llm_temp, llm_top_p,
                    prompts,
                    freq_penalty=freq_penalty,
                )
            entry = {
                "name": dim_config.get("name", dim_name),
                "raw_result": result,
            }
            if dim_name in rule_results:
                entry["rule_data"] = rule_results[dim_name]
            results[dim_name] = entry

            # 后处理：清洗 LLM 幻觉
            cleaned_result = _clean_result(dim_name, result)

            # 保存单维度结果
            dim_path = output_dir / f"{dim_name}.txt"
            with open(dim_path, "w", encoding="utf-8") as f:
                f.write(cleaned_result)
            print(f"[distill] {dim_name} saved to {dim_path}")

        except Exception as e:
            print(f"[distill] ERROR on {dim_name}: {e}")
            results[dim_name] = {
                "name": dim_config.get("name", dim_name),
                "error": str(e),
            }

    # 保存汇总
    summary_path = output_dir / "distillation_result.json"
    with open(summary_path, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    print(f"\n[distill] Complete. Results saved to {summary_path}")

    return results
