"""
transcript 歌词清洗器 v2
----------------------
从 ASR 转录文本中检测并移除背景歌曲歌词碎片。

v2 改进:
  - 基于空格分隔的 fragment 而非句子（适配 SenseVoice 输出格式）
  - 严格的"口语标记优先"策略：含口语标记的不删
  - 连续歌词片段合并检测
  - 极大的减少误删
"""

import re
import sys
from pathlib import Path
from typing import List, Dict


# ---------------------------------------------------------------------------
# 口语标记词 —— 只要包含这些词的 fragment 一律保留
# ---------------------------------------------------------------------------
SPEECH_MARKERS = {
    # 人称/称呼
    '我', '你', '他', '她', '咱', '人家', '自己', '大家', '各位',
    '你们', '他们', '我们', '咱们',
    # 口语连接词
    '然后', '就是', '那个', '这个', '完了', '而且', '但是', '因为',
    '所以', '其实', '不过', '如果', '反正', '特别', '比较',
    # 疑问/感叹
    '怎么', '什么', '为啥', '为什么', '真的', '不是', '是吗',
    '对不对', '知道', '觉得', '应该', '可以', '可能',
    # 直播常用
    '感谢', '谢谢', '欢迎', '拜拜', '晚安', '来了', '走了',
    '开播', '下播', '直播', '上麦', '连麦', 'PK',
    '宝宝', '粉丝', '观众', '大哥', '大姐', '小姐姐',
    '礼物', '点赞', '关注', '转发',
    # 日常话题
    '好吃', '不好吃', '喜欢', '不喜欢', '很', '不太',
    '今天', '昨天', '明天', '刚才', '现在', '晚上', '早上',
    '吃', '喝', '玩', '看', '说', '做', '买', '卖', '去', '来',
    # 地名
    '沈阳', '哈尔滨', '三亚', '东北', '黑龙江', '绥化', '辽阳',
    # 语气词/口语特征（但单字的不算）
    '感觉', '好像', '反正', '确实', '哎呀', '哎哟',
    '学校', '大学', '高中', '高考', '专业', '服装', '设计',
    '装修', '空调', '风扇', '口红', '照片',
    '我妈', '我爸', '我姐', '我弟', '我老',
    # 元元说的典型内容词
    '干锅', '鸭头', '雪莲', '雪糕', '冰棍', '可乐', '火锅',
    '马迭尔', '老中街', '布丁', '辣条', '鸡爪',
    '穿越火线', '游戏', '热巴', '王安宇', '古装',
    '入口', '变化', '预哥', '月哥', '为准',
    '肚子', '拜拜', '等一下', '没事', '这块',
}


# ---------------------------------------------------------------------------
# 歌词强信号 —— 单独出现不足以判歌词，但多信号叠加则判定
# ---------------------------------------------------------------------------

# 古风关键词（单独出现可能是正常用词，多次出现概率大）
POETIC_KEYWORDS = {
    '红尘', '长安', '桃花', '明月', '天涯', '相思', '风雪',
    '烛火', '星船', '落花', '渡口', '轮回', '忘川', '奈何',
    '琴弦', '残梦', '孽缘', '彼岸', '朝暮', '烽火', '沧桑',
    '江湖', '春秋', '烟雨', '婵娟', '霓裳', '辞镜', '朱颜',
    '青丝', '白发', '笙歌', '琵琶', '羌笛', '折柳',
}

# 明显是现代歌词/古诗的完整短句模式
LYRIC_PHRASES = {
    # 完整 lyrics phrases found in the transcript
    '摘一朵桃花', '一曲诺此生', '长安那秋风流',
    '明月高悬微风', '不见旧颜色', '叹烽火人生河',
    '长此长船又如何', '尽满城烛火', '梦伴尽漫天雨落',
    '风起十子之', '君枝一霎冰雪暖眼泪',
    '剩仙人过从前他满了西桥下', '请放下',
    '花开遍不经', '临别前重不好', '临泉渡水白',
    '惆怅人间歌', '谁才是我', '梦今长',
    '一生只无你',
    '位卑为难', '此生无你',
    '潮起潮', '天世痴情寞',
    '人去楼空', '花落谁家', '风雨同舟',
    '与星船', '红尘', '一曲诺此生',
}

# 英文歌词碎片
ENGLISH_LYRIC_WORDS = {
    'beautiful', 'baby', 'girl', 'sky', 'yeah', 'life', 'love',
    'night', 'dream', 'heart', 'forever', 'remember', 'wonderful',
}


def _has_speech_marker(text: str) -> bool:
    """检查是否包含任何口语标记（含则 100% 保留）"""
    for marker in SPEECH_MARKERS:
        if marker in text:
            return True
    return False


def _is_pure_lyric_fragment(text: str) -> bool:
    """
    判断一个文本片段是否纯歌词（不含口语成分）。
    采用多信号叠加策略，减少误判。
    """
    text = text.strip()
    if not text or len(text) <= 1:
        return True  # 单个字符视为噪声

    # 已知非歌词词汇（口语/人名/常见词），无论如何不删
    SAFE_WORDS = {'预哥', '月哥', '为准', '入口', '变化', '拜拜', '等一下', '呵呵呵', '哈哈哈', '肚子痛'}
    for sw in SAFE_WORDS:
        if sw in text:
            return False

    # 如果有口语标记 → 不是歌词
    if _has_speech_marker(text):
        return False

    # 纯数字/标点 → 不处理
    if re.match(r'^[\d\s\.\,\;\:\!\?\'\"\(\)\[\]\{\}]+$', text):
        return False

    # 策略：统计歌词信号数量，信号多则判定为歌词
    signals = 0

    # 去除中文标点用于模式匹配（但原始 text 保留用于 speech marker 检查）
    text_no_punct = text.rstrip('。，！？；：、""''…～—').rstrip(',')

    # 信号1: 匹配已知歌词短语（检查去标点前后的版本）
    if text in LYRIC_PHRASES or text_no_punct in LYRIC_PHRASES:
        signals += 5  # 强信号

    # 信号2: 包含古风关键词
    text_clean = text_no_punct.replace('。', '').replace('，', '').replace('！', '').replace('？', '')
    poetic_count = sum(1 for kw in POETIC_KEYWORDS if kw in text)
    signals += poetic_count * 2

    # 信号3: 纯 5 字/7 字短句且不包含口语
    if re.match(r'^[\u4e00-\u9fff]{5}$', text_clean):
        signals += 1  # 5字句可能是歌词也可能是正常短句
    if re.match(r'^[\u4e00-\u9fff]{7}$', text_clean):
        signals += 2  # 7字句更像歌词

    # 信号4: 包含英文单词（且无口语词）
    lower_text = text.lower()
    eng_count = sum(1 for w in ENGLISH_LYRIC_WORDS if w in lower_text)
    signals += eng_count * 3

    # 信号5: 太短的、无法构成句子的碎片
    if len(text_clean) <= 3:
        signals += 1
    elif len(text_clean) <= 6 and not re.search(r'[\u4e00-\u9fff]{3,}', text_clean):
        signals += 1

    # 判定阈值: 信号 >= 2 则为歌词
    return signals >= 2


def _find_removable_fragments(fragments: List[str]) -> List[int]:
    """
    找到所有可移除的歌词 fragment 的索引。

    额外规则：孤立的歌词片段（前后也是歌词或噪声）移除。
    如果一段歌词被口语包围，则保留（可能她说了一句歌词或在哼唱）。
    """
    removable = []
    n = len(fragments)

    for i, frag in enumerate(fragments):
        if not _is_pure_lyric_fragment(frag):
            continue

        # 检查上下文：只有当两侧都是真实口语时才保留
        # （排除单字"嗯""啊"等 ASR 噪声造成的假邻居）
        def _is_real_speech(fragment: str) -> bool:
            """真实口语：包含至少一个 2字+ 的口语标记，或整体长度 >= 8"""
            if len(fragment.strip()) >= 8:
                return True
            for marker in SPEECH_MARKERS:
                if len(marker) >= 2 and marker in fragment:
                    return True
            return False

        prev_is_speech = i > 0 and _is_real_speech(fragments[i - 1])
        next_is_speech = i < n - 1 and _is_real_speech(fragments[i + 1])

        # 孤立歌词片段（无口语邻居或在纯歌词区域）→ 移除
        # 仅当两侧都是真实口语时才保留（主播可能在引用/哼唱）
        if prev_is_speech and next_is_speech:
            continue

        removable.append(i)

    return removable


def clean_transcript(input_path: Path, output_path: Path, verbose: bool = False) -> Dict:
    """
    清洗转录文本，移除歌词碎片。

    工作方式：
    1. 按空格/换行分割成 fragments
    2. 对每个 fragment 判断是否为纯歌词
    3. 移除确认为歌词的 fragments
    4. 重新拼接并输出
    """
    with open(input_path, "r", encoding="utf-8") as f:
        raw_text = f.read()

    # Split by whitespace/newlines to get fragments
    fragments = re.split(r'[\s\n]+', raw_text)
    fragments = [f for f in fragments if f]  # remove empty

    total_chars = sum(len(f) for f in fragments)

    # Find lyrics to remove
    remove_indices = set(_find_removable_fragments(fragments))

    removed_frags = []
    kept_frags = []
    for i, frag in enumerate(fragments):
        if i in remove_indices:
            removed_frags.append(frag)
            if verbose and len(frag) > 3:
                print(f"  [RM] [{len(frag)}c] {frag[:70]}")
        else:
            kept_frags.append(frag)

    cleaned_text = " ".join(kept_frags)
    removed_chars = sum(len(f) for f in removed_frags)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(cleaned_text)

    stats = {
        "original_fragments": len(fragments),
        "cleaned_fragments": len(kept_frags),
        "removed_fragments": len(removed_frags),
        "original_chars": total_chars,
        "cleaned_chars": len(cleaned_text),
        "removed_chars": removed_chars,
        "removal_ratio": f"{removed_chars / max(total_chars, 1) * 100:.1f}%",
    }

    return stats


def batch_clean(transcript_dir: Path, output_dir: Path, verbose: bool = False) -> List[Dict]:
    """批量清洗目录下所有转录文本"""
    output_dir.mkdir(parents=True, exist_ok=True)
    results = []

    for txt_file in sorted(transcript_dir.glob("*.txt")):
        print(f"[clean] Processing: {txt_file.name}")
        out_path = output_dir / txt_file.name
        stats = clean_transcript(txt_file, out_path, verbose=verbose)
        stats["file"] = txt_file.name
        results.append(stats)
        print(f"  {txt_file.name}: {stats['original_chars']} -> {stats['cleaned_chars']} chars "
              f"(-{stats['removal_ratio']}, {stats['removed_fragments']} fragments)")

    total_removed = sum(r["removed_chars"] for r in results)
    total_original = sum(r["original_chars"] for r in results)
    total_frags_removed = sum(r["removed_fragments"] for r in results)
    print(f"\n[clean] Total: {total_original} -> {total_original - total_removed} chars "
          f"(-{total_removed / max(total_original, 1) * 100:.1f}%), "
          f"{total_frags_removed} fragments removed")

    return results


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="清洗 ASR 转录文本中的歌词碎片 v2")
    parser.add_argument("--input", "-i", required=True, help="输入转录 .txt 文件或目录")
    parser.add_argument("--output", "-o", default=None, help="输出路径")
    parser.add_argument("--verbose", "-v", action="store_true", help="显示详细日志")
    args = parser.parse_args()

    input_path = Path(args.input)
    if args.output:
        output_path = Path(args.output)
    else:
        output_path = input_path.parent / "cleaned"

    if input_path.is_dir():
        batch_clean(input_path, output_path, verbose=args.verbose)
    elif input_path.is_file():
        out_file = output_path / input_path.name if output_path.is_dir() else output_path
        stats = clean_transcript(input_path, out_file, verbose=args.verbose)
        print(f"\nStats: {stats}")
    else:
        print(f"ERROR: {input_path} not found")
        sys.exit(1)
