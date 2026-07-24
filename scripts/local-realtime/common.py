#!/usr/bin/env python3
"""本地实时语音对话：共享协议 / VAD / ASR / LLM / 打断逻辑。

各入口（server.py / server_cosyvoice.py）负责加载 TTS，并调用 run(port, name)。
"""

from __future__ import annotations

import asyncio
import json
import os
import queue
import re
import ssl
import struct
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import wave
from concurrent.futures import Executor, ThreadPoolExecutor
from pathlib import Path
from typing import Callable

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent.parent
VOICE_AB = REPO / "scripts" / "voice-ab"
# 打包后由桌宠注入：可写运行时（venv / 参考音副本）
_RUNTIME = Path(os.environ["KXYY_VOICE_RUNTIME"]).expanduser() if os.environ.get("KXYY_VOICE_RUNTIME") else None


def _ensure_cli_path() -> None:
    """GUI 启动的进程 PATH 常缺 Homebrew，补全常见工具路径（ffmpeg 等）。"""
    extra: list[str] = []
    if sys.platform == "darwin":
        extra.extend(["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin"])
    elif sys.platform.startswith("linux"):
        extra.extend(["/usr/local/bin", "/snap/bin"])
    current = os.environ.get("PATH", "")
    seen = {p for p in current.split(os.pathsep) if p}
    prepend = [p for p in extra if p not in seen]
    if prepend:
        os.environ["PATH"] = os.pathsep.join(prepend + ([current] if current else []))


def _ffmpeg_cmd() -> str:
    import shutil

    _ensure_cli_path()
    path = shutil.which("ffmpeg")
    if path:
        return path
    raise RuntimeError(
        "未找到 ffmpeg（实时通话 ASR 需要）。macOS 请运行：brew install ffmpeg，然后重启语音服务。"
    )


_ensure_cli_path()


def _subprocess_no_window() -> dict:
    """Windows：给 subprocess 加 CREATE_NO_WINDOW，避免 ffmpeg 等控制台子进程弹出黑框。

    桌宠拉起本服务时已用 CREATE_NO_WINDOW 隐藏了 python 控制台；但本进程再调用 ffmpeg
    这类控制台程序时，因当前进程无控制台，子进程会**新分配**一个控制台窗口一闪而过。
    这里为子进程显式带上同一标志，把这些一闪的黑框也消掉。非 Windows 返回空 kwargs。
    """
    if os.name == "nt":
        return {"creationflags": 0x08000000}  # CREATE_NO_WINDOW
    return {}


def _patch_kaldifst_nonascii_paths() -> None:
    """Windows 下 kaldifst 无法打开含非 ASCII 字符的路径（其 C++ kaldi-io 用窄字符
    ifstream 打开文件，遇到中文/日文等路径会失败）。而本应用默认装在
    ``%LOCALAPPDATA%\\元元桌宠\\...``（中文目录），导致 wetext 在加载内置 .fst 时报
    ``Error opening input stream``，IndexTTS-2 / CosyVoice 的文本归一化随之挂掉。

    这里包住 ``kaldifst.TextNormalizer``：凡传入路径含非 ASCII 字符，就先把该文件复制到
    一个纯 ASCII 的缓存目录，再用 ASCII 路径打开。必须在 ``import wetext`` 之前生效——
    ``wetext.constants`` 在被导入时即用 ``kaldifst.TextNormalizer`` 预加载全部 FST。
    仅在 Windows 生效；任何异常都静默跳过，绝不影响正常路径下的启动。
    """
    if os.name != "nt":
        return
    try:
        import hashlib
        import shutil

        import kaldifst  # type: ignore
    except Exception:
        return

    def _is_ascii(s: str) -> bool:
        try:
            s.encode("ascii")
            return True
        except UnicodeEncodeError:
            return False

    def _ascii_cache_root() -> str | None:
        cands: list[str] = []
        pub = os.environ.get("PUBLIC")
        if pub:
            cands.append(os.path.join(pub, "kxyy-tts", "kaldifst"))
        tmp = os.environ.get("TEMP") or os.environ.get("TMP") or tempfile.gettempdir()
        if tmp:
            cands.append(os.path.join(tmp, "kxyy-tts-kaldifst"))
        sysdrv = os.environ.get("SystemDrive", "C:")
        cands.append(os.path.join(sysdrv + os.sep, "kxyy-tts-kaldifst"))
        for c in cands:
            if not _is_ascii(c):
                continue
            try:
                os.makedirs(c, exist_ok=True)
                return c
            except OSError:
                continue
        return None

    root = _ascii_cache_root()
    if not root:
        return

    def _ascii_path(path) -> str:
        p = str(path)
        if _is_ascii(p) or not os.path.isfile(p):
            return p
        # 以原始路径的 hash 建子目录、保留原文件名，避免不同语言目录下同名 .fst 冲突。
        key = hashlib.md5(p.encode("utf-8")).hexdigest()
        dst_dir = os.path.join(root, key)
        dst = os.path.join(dst_dir, os.path.basename(p))
        try:
            if not os.path.isfile(dst) or os.path.getsize(dst) != os.path.getsize(p):
                os.makedirs(dst_dir, exist_ok=True)
                shutil.copy2(p, dst)
        except OSError:
            return p
        return dst

    orig = kaldifst.TextNormalizer

    def _patched(path, *args, **kwargs):
        return orig(_ascii_path(path), *args, **kwargs)

    try:
        kaldifst.TextNormalizer = _patched
    except Exception:
        pass


def _patch_sentencepiece_nonascii_paths() -> None:
    """Windows 下 sentencepiece 的 C++ ``LoadFromFile`` 同样打不开含非 ASCII 字符的
    路径（本应用装在中文目录 ``元元桌宠`` 下时，加载 ``bpe.model`` 报 ``Not found``）。

    这里包住 ``SentencePieceProcessor.LoadFromFile``：路径含非 ASCII 时，改用 Python 读取
    文件字节并走 ``LoadFromSerializedProto``（纯内存加载，绕开 C++ 的窄字符路径打开）。
    仅在 Windows 生效；任何异常都静默跳过。
    """
    if os.name != "nt":
        return
    try:
        import sentencepiece as spm  # type: ignore
    except Exception:
        return

    def _is_ascii(s: str) -> bool:
        try:
            s.encode("ascii")
            return True
        except UnicodeEncodeError:
            return False

    orig_load = spm.SentencePieceProcessor.LoadFromFile

    def _patched_load(self, arg):
        try:
            p = str(arg) if arg is not None else arg
            if p and not _is_ascii(p) and os.path.isfile(p):
                with open(p, "rb") as f:
                    return self.LoadFromSerializedProto(f.read())
        except Exception:
            pass
        return orig_load(self, arg)

    try:
        spm.SentencePieceProcessor.LoadFromFile = _patched_load
    except Exception:
        pass


# 在任何后端 import wetext / sentencepiece 之前打上补丁（本模块被所有入口最先 import）。
_patch_kaldifst_nonascii_paths()
_patch_sentencepiece_nonascii_paths()


# 人设卡 → 内置参考音目录（与 persona-cards/<id>、settings.personaCardId 对齐）
DEFAULT_VOICE_CARD_ID = "kxyy-yuanyuan"
# 空 personaCardId（设置里选「开心元元」）映射到默认卡
VOICE_CARD_ALIASES = {
    "": DEFAULT_VOICE_CARD_ID,
}


def resolve_voice_card_id(raw: str | None = None) -> str:
    """归一化人设卡 ID，用于查找 assets/<cardId>/ 参考音。"""
    if raw is None:
        try:
            raw = (load_settings().get("personaCardId") or "").strip()
        except Exception:
            raw = ""
    else:
        raw = (raw or "").strip()
    return VOICE_CARD_ALIASES.get(raw, raw) or DEFAULT_VOICE_CARD_ID


def _assets_root() -> Path:
    return ROOT / "assets"


def _audio_candidates_in_dir(d: Path) -> list[Path]:
    """优先 ref.*，其次目录内任意常见音频。"""
    if not d.is_dir():
        return []
    preferred = ("ref.wav", "ref.mp3", "ref.m4a", "ref.flac", "ref.ogg")
    out: list[Path] = []
    for name in preferred:
        p = d / name
        if p.is_file():
            out.append(p)
    if out:
        return out
    exts = {".wav", ".mp3", ".m4a", ".flac", ".ogg"}
    return sorted(
        p for p in d.iterdir() if p.is_file() and p.suffix.lower() in exts
    )


def builtin_ref_for_card(card_id: str) -> tuple[Path | None, str]:
    """返回 (音频路径, 文案)。找不到音频时路径为 None。"""
    cid = resolve_voice_card_id(card_id)
    roots = [_assets_root() / cid]
    # 开发态兼容：旧扁平文件名
    if cid == DEFAULT_VOICE_CARD_ID:
        roots.append(_assets_root())
    for root in roots:
        audios = _audio_candidates_in_dir(root)
        # 旧布局：assets/kxyy-wechat-record-cut01_15s.wav
        if not audios and root == _assets_root():
            legacy = root / "kxyy-wechat-record-cut01_15s.wav"
            if legacy.is_file():
                audios = [legacy]
        if not audios:
            continue
        wav = audios[0]
        text = ""
        for txt in (wav.with_suffix(".txt"), root / "ref.txt"):
            if txt.is_file():
                text = txt.read_text(encoding="utf-8").strip()
                if text:
                    break
        return wav, text
    return None, ""


def _ref_candidates() -> list[Path]:
    """兼容旧调用：默认卡参考音候选路径列表。"""
    paths: list[Path] = []
    wav, _ = builtin_ref_for_card(DEFAULT_VOICE_CARD_ID)
    if wav is not None:
        paths.append(wav)
    if _RUNTIME is not None:
        paths.append(_RUNTIME / "out" / "kxyy-yuanyuan" / "ref.wav")
        paths.append(_RUNTIME / "out" / "kxyy-wechat-record-cut01_15s.wav")
    paths.append(VOICE_AB / "out" / "kxyy-wechat-record-cut01_15s.wav")
    return paths


def ref_wav_path() -> Path:
    for p in _ref_candidates():
        if p.is_file():
            return p
    if _RUNTIME is not None:
        return _RUNTIME / "out" / "kxyy-yuanyuan" / "ref.wav"
    return VOICE_AB / "out" / "kxyy-wechat-record-cut01_15s.wav"


def ref_txt_path() -> Path:
    wav = ref_wav_path()
    return wav.with_suffix(".txt")


REF_WAV = VOICE_AB / "out" / "kxyy-wechat-record-cut01_15s.wav"  # 兼容旧引用；运行时请用 ref_wav_path()
REF_TXT = VOICE_AB / "out" / "kxyy-wechat-record-cut01_15s.txt"
MERGED_MP3 = REPO / "merged.mp3"

# 内置兜底参考音文案（仅对应默认卡 kxyy-yuanyuan/ref.*）。
_DEFAULT_REF_TEXT = (
    "对的，这是先实验一个小聚会，然后这个要是成功了的话，咱们之后就可以再换一个地方，"
    "然后之后咱们办一个稍微大一点的，然后去的可以稍微多一点，因为现在太敏感了。"
    "现在的话, 这个时候, 嗯这两天就很敏感"
)


def _settings_path() -> Path:
    """settings.json 的跨平台位置，须与 Rust 侧 dirs_settings_path() 保持一致。

    - macOS:   ~/Library/Application Support/<bundleId>/settings.json
    - Windows: %APPDATA%\\<bundleId>\\settings.json（Roaming，Tauri app_config_dir）
    - Linux:   ~/.config/<bundleId>/settings.json
    此前写死为 macOS 路径，导致 Windows 上永远读不到设置，
    本地语音服务因缺 deepseekKey / 模型路径而启动即退出。
    """
    bundle = "com.aaronfang.kxyydesktoppet"
    if sys.platform == "darwin":
        return Path.home() / "Library/Application Support" / bundle / "settings.json"
    if os.name == "nt":
        base = os.environ.get("APPDATA")
        root = Path(base) if base else (Path.home() / "AppData" / "Roaming")
        return root / bundle / "settings.json"
    base = os.environ.get("XDG_CONFIG_HOME")
    root = Path(base) if base else (Path.home() / ".config")
    return root / bundle / "settings.json"


SETTINGS = _settings_path()

INPUT_RATE = 16000
OUTPUT_RATE = 24000
FRAME_MS = 30
FRAME_SAMPLES = INPUT_RATE * FRAME_MS // 1000

SPEECH_RMS = 0.018
# 测试期 soft endpoint：先标记可能句尾，再保留 reopen 窗口兼容中文思考停顿。
# 两者均为 30ms 帧的整数倍；约 1.05s 无续说后提交，替代原固定 2s 判停。
SOFT_END_MS = 480
SOFT_REOPEN_MS = 570
ENDPOINT_COMMIT_MS = SOFT_END_MS + SOFT_REOPEN_MS
MIN_SPEECH_MS = 500
# 单句最长录音（安全阀，防异常一直录）。日常聊天够用；真要长独白可再加大。
MAX_SPEECH_MS = 60000
# 空闲态打断门槛
BARGE_IN_RMS = 0.022
BARGE_IN_FRAMES = 6
# AI 播报中：更高更久才采信（防外放漏音/杂音）；确认前不停播、不发 asr_start
BARGE_IN_RMS_PLAY = 0.04
BARGE_IN_FRAMES_PLAY = 12  # ~360ms
MAX_HISTORY_MESSAGES = 24
MAX_PENDING_HISTORY_TURNS = 4
MAX_AUDIO_SEGMENTS_PER_TURN = 64
LLM_STREAM_QUEUE_MAX = 32
LLM_STREAM_MAX_PRODUCERS = 2
TTS_STREAM_MAX_TASKS = 2
TTS_SENTENCE_QUEUE_MAX = 4
TTS_PARALLELISM_MAX = 2
# 单个稳定句最多保留 60 秒 24kHz mono s16le；数量有界之外也限制 PCM 字节。
TTS_SENTENCE_MAX_SAMPLES = OUTPUT_RATE * 60
LLM_REPLY_MAX_CHARS = 4096
STABLE_SENTENCE_MIN_CHARS = 6
STABLE_SENTENCE_SOFT_CHARS = 40
STABLE_SENTENCE_HARD_CHARS = 60
MIN_SPEECH_MS_PLAY = 800
NO_SPEECH_PROB_MAX = 0.55
MIN_CJK_CHARS = 2

WHISPER_MODEL = "mlx-community/whisper-large-v3-turbo"
WHISPER_PROMPT = "以下是一段中文对话，角色名叫元元。"

_CJK_RE = re.compile(r"[\u4e00-\u9fff]")
_FILLER_RE = re.compile(
    r"^(嗯+|啊+|呃+|哦+|噢+|唔+|恩+|嘿+|欸+|唉+|那个|这|啊哈|哈哈+|嘿嘿+)+$"
)
_HALLUCINATION_RE = re.compile(r"字幕|订阅|点赞|鸣谢|翻译|thanks for watching", re.I)


class SoftEndpoint:
    """只处理帧级 voiced/quiet 决策的纯状态机，不持有 PCM 或 wall clock。"""

    def __init__(
        self,
        *,
        frame_ms: int = FRAME_MS,
        soft_end_ms: int = SOFT_END_MS,
        reopen_ms: int = SOFT_REOPEN_MS,
    ):
        if frame_ms <= 0 or soft_end_ms <= 0 or reopen_ms <= 0:
            raise ValueError("endpoint durations must be positive")
        self.frame_ms = frame_ms
        self.soft_end_ms = soft_end_ms
        self.commit_ms = soft_end_ms + reopen_ms
        self.silence_ms = 0
        self.state = "speaking"

    def reset(self) -> None:
        self.silence_ms = 0
        self.state = "speaking"

    def observe(self, voiced: bool, *, eligible: bool) -> str | None:
        if voiced:
            reopened = self.state == "soft_end"
            self.reset()
            return "reopened" if reopened else None

        if self.state == "committed":
            return None
        self.silence_ms += self.frame_ms
        if not eligible:
            return None
        if self.state == "speaking" and self.silence_ms >= self.soft_end_ms:
            self.state = "soft_end"
            return "soft_end"
        if self.state == "soft_end" and self.silence_ms >= self.commit_ms:
            self.state = "committed"
            return "committed"
        return None


class GenerationCancelScope:
    """单调 generation 的显式取消域；阻塞调用返回后必须重新检查 active。"""

    def __init__(self, generation: int, stage: str):
        self.generation = generation
        self.stage = stage
        self.state = "active"
        self.reason = ""
        self.inactive = threading.Event()

    @property
    def active(self) -> bool:
        return self.state == "active"

    def cancel(self, reason: str) -> None:
        if self.active:
            self.state = "cancelled"
            self.reason = reason
            self.inactive.set()

    def complete(self) -> None:
        if self.active:
            self.state = "completed"
            self.inactive.set()

    def promote(self, stage: str) -> None:
        if self.active:
            self.stage = stage


class StableSentenceBuffer:
    """有界纯状态分句器：优先强句末，长句回退到弱断点，最后硬切。"""

    STRONG = frozenset("。！？!?；;\n")
    WEAK = frozenset("，,、：:")

    def __init__(
        self,
        *,
        min_chars: int = STABLE_SENTENCE_MIN_CHARS,
        soft_chars: int = STABLE_SENTENCE_SOFT_CHARS,
        hard_chars: int = STABLE_SENTENCE_HARD_CHARS,
    ):
        if not (0 < min_chars <= soft_chars <= hard_chars and min_chars * 2 <= hard_chars):
            raise ValueError(
                "sentence limits must satisfy 0 < min <= soft <= hard and 2*min <= hard"
            )
        self.min_chars = min_chars
        self.soft_chars = soft_chars
        self.hard_chars = hard_chars
        self._buffer = ""
        self._cancelled = False

    @property
    def buffered_chars(self) -> int:
        return len(self._buffer)

    def feed(self, delta: str) -> list[str]:
        if self._cancelled or not delta:
            return []
        self._buffer += str(delta)
        ready: list[str] = []
        while self._buffer:
            cut = self._strong_cut()
            if cut is None and len(self._buffer) >= self.soft_chars:
                cut = self._weak_cut()
            if cut is None and len(self._buffer) >= self.hard_chars:
                # 给下一 delta 至少保留 min_chars；若句号紧随 hard boundary 到达，
                # 它会与尾段一起提交，而不会成为单独的标点 TTS 请求。
                cut = self.hard_chars - self.min_chars
            if cut is None:
                break
            part = self._buffer[:cut].strip()
            self._buffer = self._buffer[cut:]
            if part and any(char.isalnum() for char in part):
                ready.append(part)
        return ready

    def flush(self) -> list[str]:
        if self._cancelled:
            return []
        part = self._buffer.strip()
        self._buffer = ""
        return [part] if part and any(char.isalnum() for char in part) else []

    def cancel(self) -> None:
        self._cancelled = True
        self._buffer = ""

    def _strong_cut(self) -> int | None:
        for index, char in enumerate(self._buffer[: self.hard_chars]):
            if char in self.STRONG and index + 1 >= self.min_chars:
                return index + 1
        return None

    def _weak_cut(self) -> int | None:
        upper = min(len(self._buffer), self.hard_chars)
        for index in range(upper - 1, self.min_chars - 2, -1):
            if self._buffer[index] in self.WEAK:
                return index + 1
        return None


class AudibleHistory:
    """只把前端确认播完的句段写入下一轮上下文。

    ``generated`` 文本只在当前回复管线中短暂存在；这里保存的 assistant
    内容全部来自不含文本的 ``generation + segmentId`` 播放回执。turn/segment
    ledger 都有固定上限，迟到或未知回执会被忽略。
    """

    def __init__(
        self,
        *,
        max_messages: int = MAX_HISTORY_MESSAGES,
        max_pending_turns: int = MAX_PENDING_HISTORY_TURNS,
    ):
        if max_messages < 2 or max_pending_turns < 1:
            raise ValueError("history limits must be positive")
        self.max_messages = max_messages
        self.max_pending_turns = max_pending_turns
        self.messages: list[dict] = []
        self._turns: dict[int, dict] = {}
        self._order: list[int] = []

    def begin_turn(self, generation: int, user_text: str) -> list[dict]:
        """返回当前轮之前的快照，再登记当前用户输入。"""
        snapshot = [dict(message) for message in self.messages]
        user_message = {"role": "user", "content": user_text}
        self.messages.append(user_message)
        self._turns[generation] = {
            "user": user_message,
            "assistant": None,
            "segments": [],
            "segmentIds": set(),
            "completed": set(),
            "cancelled": False,
        }
        self._order.append(generation)
        while len(self._order) > self.max_pending_turns:
            expired = self._order.pop(0)
            self._turns.pop(expired, None)
        self._trim()
        return snapshot

    def add_segment(self, generation: int, segment_id: int, text: str) -> bool:
        turn = self._turns.get(generation)
        clean = str(text or "").strip()
        if turn is None or not clean or segment_id in turn["segmentIds"]:
            return False
        if len(turn["segments"]) >= MAX_AUDIO_SEGMENTS_PER_TURN:
            return False
        turn["segmentIds"].add(segment_id)
        turn["segments"].append({"id": segment_id, "text": clean})
        return True

    def acknowledge(self, generation: int, segment_id: int, state: str) -> bool:
        turn = self._turns.get(generation)
        if (
            turn is None
            or turn["cancelled"]
            or state != "completed"
            or segment_id not in turn["segmentIds"]
        ):
            return False
        turn["completed"].add(segment_id)
        audible_parts: list[str] = []
        for segment in turn["segments"]:
            if segment["id"] not in turn["completed"]:
                break
            audible_parts.append(segment["text"])
        audible = "".join(audible_parts).strip()
        if not audible:
            return False
        assistant = turn["assistant"]
        if assistant is None:
            assistant = {"role": "assistant", "content": audible}
            turn["assistant"] = assistant
            try:
                user_index = next(
                    index
                    for index, message in enumerate(self.messages)
                    if message is turn["user"]
                )
            except StopIteration:
                return False
            self.messages.insert(user_index + 1, assistant)
        else:
            assistant["content"] = audible
        self._trim()
        return True

    def cancel_turn(self, generation: int) -> None:
        turn = self._turns.get(generation)
        if turn is not None:
            turn["cancelled"] = True

    def _trim(self) -> None:
        overflow = len(self.messages) - self.max_messages
        if overflow > 0:
            del self.messages[:overflow]
        # 不能让 OpenAI-compatible history 以孤立 assistant 开头；满容量时
        # 宁可再丢一条最旧回复，也要保持剩余上下文的角色顺序可解释。
        while self.messages and self.messages[0].get("role") == "assistant":
            del self.messages[0]


class SafeRealtimeError(RuntimeError):
    """可安全回给前端/日志的固定文案；原始上游异常只保留为 exception cause。"""


# 各 TTS 后端共用的 LLM 输出约束（下沉自 tts_*.py，避免多处漂移）。
SYSTEM_SUFFIX = (
    "\n口语化一两句，像真人闲聊；需要停顿时用逗号或……；"
    "可带神态括号如（开心）（小声）（生气）（难过），括号不会被念出。"
)

_CUE_RE = re.compile(r"（[^（）]*）|\([^()]*\)|【[^【】]*】|\*[^*]+\*")


def detect_emotion(raw: str) -> str:
    """从原始回复（含神态括号）推断情绪标签，三个本地 TTS 后端共用。

    与前端 tts.js detectEmotion 保持同一套规则；以此函数为后端唯一实现。
    """
    t = str(raw or "")
    cues = " ".join(_CUE_RE.findall(t))
    hay = f"{cues} {t}"

    def has(pat: str) -> bool:
        return re.search(pat, hay) is not None

    if has(r"生气|愤怒|哼|讨厌|可恶|不许|不准|凶|烦死|气死"):
        return "angry"
    if has(r"难过|伤心|委屈|呜+|哭|失落|叹气|对不起|抱歉|心疼"):
        return "sad"
    if has(r"害羞|脸红|小声|不好意思|羞|嘀咕|扭捏"):
        return "shy"
    if has(r"温柔|抱抱|乖|安慰|轻声|摸摸|别怕|没事的|来嘛|乖乖"):
        return "gentle"
    bangs = len(re.findall(r"[!！]", t))
    if (
        has(r"开心|高兴|兴奋|哈哈+|嘿嘿|耶+|太好了|好耶|哇+|嘻嘻|冲鸭|棒")
        or bangs >= 2
        or re.search(r"[~～]", t)
    ):
        return "excited"
    return "neutral"


def text_for_speech(raw: str) -> str:
    """去掉神态括号，保留……与顿号，便于节奏表演。三个本地 TTS 后端共用。"""
    t = _CUE_RE.sub("", str(raw or ""))
    # 规范省略号，帮助模型拉长停顿
    t = t.replace("...", "……").replace("。。。", "……")
    t = re.sub(r"[~～]{2,}", "～", t)
    t = re.sub(r"[ \t]+", " ", t).strip()
    return t


def resolve_repo_path(raw: str, default: "Path") -> "Path":
    """把设置里的路径解析为绝对路径：空 → default；相对 → 相对仓库根。"""
    p = (raw or "").strip()
    if not p:
        return default.expanduser().resolve()
    path = Path(p).expanduser()
    if not path.is_absolute():
        path = (REPO / path).resolve()
    return path


def https_context() -> "ssl.SSLContext":
    """默认走 certifi/系统证书校验的 HTTPS/WSS 上下文。

    仅当显式设置环境变量 KXYY_TTS_INSECURE_SSL=1 时才降级为不校验（自担中间人风险）。
    此前多处直接用 ssl._create_unverified_context() 携带 Bearer/API Key 连线，存在凭证被窃取的隐患。
    """
    if os.environ.get("KXYY_TTS_INSECURE_SSL") == "1":
        print("[common] 警告：KXYY_TTS_INSECURE_SSL=1，已关闭 TLS 证书校验", flush=True)
        return ssl._create_unverified_context()
    try:
        import certifi

        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        return ssl.create_default_context()

# 由入口注入
_log_prefix = "local-rt"
_mlx_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="mlx")
_tts_pool: Executor | None = None
# 返回 bytes，或 (pcm_bytes, usage_dict)（CosyVoice 通话带计费字符）。
_synth_tts: Callable[[str], bytes | tuple] | None = None
# 朗读专用：返回 (audio_bytes, mime)。CosyVoice 直接回 MP3，避免 ffmpeg+24k WAV 失真。
# 返回 (audio, mime) 或 (audio, mime, usage_dict)；usage 含 characters / provider。
_synth_tts_http: Callable[[str], tuple] | None = None
_system_suffix = ""
_tts_parallelism = 1
_tts_prefetch_while_playing = False


def log(msg: str) -> None:
    print(f"[{_log_prefix}] {msg}", flush=True)


def load_settings() -> dict:
    if not SETTINGS.exists():
        return {}
    return json.loads(SETTINGS.read_text(encoding="utf-8"))


def _user_ref_from_settings() -> "tuple[Path | None, str]":
    """读取用户在设置里填写的参考音路径 / 文案（localRefWav / localRefText）。

    路径为空 → 返回 (None, 文案)，交给按人设卡查找内置参考音。
    相对路径按仓库根解析。
    """
    try:
        s = load_settings()
    except Exception:
        return None, ""
    raw = (s.get("localRefWav") or "").strip()
    text = (s.get("localRefText") or "").strip()
    if not raw:
        return None, text
    p = Path(raw).expanduser()
    if not p.is_absolute():
        p = (REPO / p).resolve()
    return p, text


def _materialize_builtin_ref(wav: Path, text: str) -> tuple[Path, str]:
    """打包资源只读时，复制到可写 runtime/out/<cardId>/ 再返回。

    源文件更大/更新（mtime）时强制覆盖，避免开发时改了 assets/ 但 runtime 仍用旧参考音。
    """
    if _RUNTIME is None:
        return wav, text
    # 已在 runtime 下则无需再拷
    try:
        wav.resolve().relative_to(_RUNTIME.resolve())
        return wav, text
    except ValueError:
        pass
    card = wav.parent.name if wav.parent.name else DEFAULT_VOICE_CARD_ID
    dest_dir = _RUNTIME / "out" / card
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / wav.name
    src_st = wav.stat()
    need_copy = not dest.is_file()
    if not need_copy:
        dst_st = dest.stat()
        need_copy = dst_st.st_size != src_st.st_size or dst_st.st_mtime < src_st.st_mtime
    if need_copy:
        dest.write_bytes(wav.read_bytes())
        log(f"已刷新 runtime 参考音 {dest} ({src_st.st_size} bytes)")
    dest_txt = dest.with_suffix(".txt")
    if text and (not dest_txt.is_file() or dest_txt.read_text(encoding="utf-8").strip() != text):
        dest_txt.write_text(text + ("\n" if not text.endswith("\n") else ""), encoding="utf-8")
    elif not text and dest_txt.is_file():
        text = dest_txt.read_text(encoding="utf-8").strip()
    return dest, text


def ensure_ref_wav() -> tuple[Path, str]:
    # 1) 用户在「设置 → 语音 → 参考音频」显式填写的录音（覆盖人设内置）。
    user_wav, user_text = _user_ref_from_settings()
    if user_wav is not None:
        if not user_wav.is_file():
            raise SystemExit(
                f"设置里指定的参考音频不存在：{user_wav}\n"
                "请在「设置 → 语音 → 参考音频」重新填入一段清晰的单人录音（建议 10~20s，wav/mp3），"
                "保存后重启语音服务。"
            )
        text = user_text
        if not text:
            sib = user_wav.with_suffix(".txt")
            if sib.is_file():
                text = sib.read_text(encoding="utf-8").strip()
        if not text:
            raise SystemExit(
                f"参考音频已设置但未填写对应文案：{user_wav}\n"
                "请在「设置 → 语音 → 参考音频文案」填入录音里说的话（须与音频逐字一致），"
                "或在同目录放置同名 .txt 文件，保存后重启语音服务。"
            )
        return user_wav, text

    # 2) 按当前人设卡选用内置参考音（assets/<personaCardId>/ref.*）。
    card_id = resolve_voice_card_id()
    wav, text = builtin_ref_for_card(card_id)
    if wav is not None:
        if not text:
            if card_id == DEFAULT_VOICE_CARD_ID:
                text = _DEFAULT_REF_TEXT
            else:
                raise SystemExit(
                    f"人设「{card_id}」的内置参考音缺少文案：{wav}\n"
                    "请在同目录放置 ref.txt（或与音频同名的 .txt），"
                    "或在设置里填写参考音频文案。"
                )
        log(f"人设卡 {card_id} 使用内置参考音 {wav}")
        return _materialize_builtin_ref(wav, text)

    # 3) 回退默认卡
    if card_id != DEFAULT_VOICE_CARD_ID:
        wav, text = builtin_ref_for_card(DEFAULT_VOICE_CARD_ID)
        if wav is not None:
            log(f"人设卡 {card_id} 无内置音色，回退 {DEFAULT_VOICE_CARD_ID}")
            return _materialize_builtin_ref(wav, text or _DEFAULT_REF_TEXT)

    raise SystemExit(
        "未找到参考音频。请在「设置 → 语音 → 参考音频」填入一段清晰的单人录音"
        "（建议 10~20s，wav/mp3 均可），或为人设卡放置 "
        f"scripts/local-realtime/assets/<cardId>/ref.wav + ref.txt。"
    )


def _ai_proxy_chat_url() -> str:
    """只允许受托管语音服务调用本机桌面代理，避免把人设/文本发往任意地址。"""
    base = (os.environ.get("KXYY_AI_PROXY_BASE") or "").strip().rstrip("/")
    parsed = urllib.parse.urlparse(base)
    try:
        port = parsed.port
    except ValueError:
        port = None
    if (
        parsed.scheme != "http"
        or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}
        or port is None
        or parsed.path not in {"", "/"}
        or parsed.username is not None
        or parsed.password is not None
        or bool(parsed.query)
        or bool(parsed.fragment)
    ):
        raise RuntimeError("本地文字代理未就绪，请从元元桌宠启动语音服务")
    return f"{base}/api/chat"


def build_llm_proxy_payload(
    system_role: str,
    history: list[dict],
    user_text: str,
) -> dict:
    """构造桌面 `/api/chat` 请求；provider/model 由 Rust 当前设置统一选择。"""
    role = system_role or "你是元元，口语化简短回复。"
    if _system_suffix:
        role = role + _system_suffix
    messages = [{"role": "system", "content": role}]
    messages.extend(history[-12:])
    messages.append({"role": "user", "content": user_text})
    return {
        "provider": "text",
        "messages": messages,
        "max_tokens": 200,
        "stream": True,
    }


def load_llm_settings() -> None:
    """启动前验证桌面代理；provider 设置与 Key 只由 Rust 读取。"""
    _ai_proxy_chat_url()
    log("文字 LLM 使用桌面统一代理")


_asr_backend = "none"  # mlx | openai | none
_openai_whisper_model = None


def load_whisper_on_mlx_thread() -> None:
    """优先 mlx-whisper（Apple Silicon）；否则回退 openai-whisper（CUDA/CPU）。"""
    global _asr_backend, _openai_whisper_model
    try:
        import mlx_whisper  # noqa: F401

        _asr_backend = "mlx"
        log("Whisper 依赖就绪 (mlx)")
        return
    except ImportError:
        pass
    try:
        import whisper

        _openai_whisper_model = whisper.load_model("small")
        _asr_backend = "openai"
        log("Whisper 依赖就绪 (openai-whisper small)")
        return
    except ImportError as e:
        _asr_backend = "none"
        raise RuntimeError(
            "未安装 mlx-whisper 或 openai-whisper，通话 ASR 不可用"
        ) from e


def pcm16_rms(pcm: bytes) -> float:
    if len(pcm) < 2:
        return 0.0
    n = len(pcm) // 2
    step = max(1, n // 64)
    total = 0.0
    count = 0
    for i in range(0, n, step):
        (v,) = struct.unpack_from("<h", pcm, i * 2)
        f = v / 32768.0
        total += f * f
        count += 1
    return (total / max(1, count)) ** 0.5


def write_wav(path: Path, pcm16: bytes, rate: int) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm16)


# 朗读单次文本上限（字）。过长易慢、易糊；拍一拍/短回复远低于此。
HTTP_TTS_MAX_CHARS = 160
# 浏览器播 WAV 更稳的采样率（24k 在部分 WebView 后半段会糊）。
BROWSER_WAV_RATE = 48000
HTTP_TTS_TIMEOUT_S = 60


def clip_speech_text(text: str, max_chars: int = HTTP_TTS_MAX_CHARS) -> str:
    t = re.sub(r"\s+", " ", (text or "").strip())
    if not t:
        return ""
    # 按码点截断，避免把汉字算成多字节。
    chars = list(t)
    if len(chars) <= max_chars:
        return t
    cut = "".join(chars[:max_chars])
    for sep in ("。", "！", "？", "；", "，", ",", " "):
        i = cut.rfind(sep)
        if i >= max_chars // 3:
            return cut[: i + 1]
    return cut + "…"


def pcm16_resample(pcm16: bytes, src_rate: int, dst_rate: int) -> bytes:
    if src_rate == dst_rate or not pcm16:
        return pcm16
    import numpy as np

    audio = np.frombuffer(pcm16, dtype=np.int16).astype(np.float32)
    if audio.size < 2:
        return pcm16
    n = max(1, int(round(audio.size * dst_rate / src_rate)))
    x_old = np.linspace(0.0, 1.0, num=audio.size, endpoint=False)
    x_new = np.linspace(0.0, 1.0, num=n, endpoint=False)
    out = np.interp(x_new, x_old, audio)
    return np.clip(out, -32768, 32767).astype(np.int16).tobytes()


def pcm16_to_wav_bytes(pcm16: bytes, rate: int = OUTPUT_RATE) -> bytes:
    import io

    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm16)
    return buf.getvalue()


def pcm16_to_browser_wav(pcm16: bytes, src_rate: int = OUTPUT_RATE) -> bytes:
    """PCM → 48k WAV，避免 WebView 播 24k WAV 后半段失真。"""
    pcm = pcm16_resample(pcm16, src_rate, BROWSER_WAV_RATE)
    return pcm16_to_wav_bytes(pcm, BROWSER_WAV_RATE)


def start_tts_http(port: int) -> None:
    """在 port+100 起 HTTP POST /tts，供桌面端文字朗读走同一本地后端。"""
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    import threading

    http_port = port + 100

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt: str, *args) -> None:  # noqa: A003
            log(f"http {self.address_string()} {fmt % args}")

        def do_GET(self) -> None:  # noqa: N802
            # 健康检查：桌宠据此确认「本服务已就绪」，区别于随机占端口的无关程序。
            if self.path.split("?", 1)[0] != "/health":
                self.send_error(404)
                return
            data = json.dumps(
                {"service": "kxyy-voice", "backend": _log_prefix}, ensure_ascii=False
            ).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self) -> None:  # noqa: N802
            if self.path.split("?", 1)[0] != "/tts":
                self.send_error(404)
                return
            # 共享 secret 鉴权：由桌宠启动本服务时经 KXYY_TTS_SECRET 注入，并在代理转发时带 X-Tts-Secret。
            # 未注入 secret（如开发者手动直跑）时不强制，保持向后兼容；一旦注入则任意本机进程无法再刷云端计费。
            secret = os.environ.get("KXYY_TTS_SECRET") or ""
            if secret and (self.headers.get("X-Tts-Secret") or "") != secret:
                self._json_err(401, "unauthorized")
                return
            try:
                n = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                n = 0
            try:
                body = json.loads(self.rfile.read(n).decode("utf-8") or "{}")
            except Exception:
                self._json_err(400, "请求体不是合法 JSON")
                return
            text = clip_speech_text((body.get("text") or "").strip())
            if not text:
                self._json_err(400, "text 不能为空")
                return
            if _synth_tts is None and _synth_tts_http is None:
                self._json_err(503, "TTS 未就绪")
                return
            t0 = time.perf_counter()
            usage: dict | None = None
            try:
                pool = _tts_pool or _mlx_pool
                if _synth_tts_http is not None:
                    result = pool.submit(_synth_tts_http, text).result(
                        timeout=HTTP_TTS_TIMEOUT_S
                    )
                    audio, mime = result[0], result[1]
                    if len(result) >= 3 and isinstance(result[2], dict):
                        usage = result[2]
                else:
                    pcm = pool.submit(_synth_tts, text).result(timeout=HTTP_TTS_TIMEOUT_S)
                    if not pcm:
                        self._json_err(502, "TTS 未返回音频")
                        return
                    audio = pcm16_to_browser_wav(pcm, OUTPUT_RATE)
                    mime = "audio/wav"
                if not audio:
                    self._json_err(502, "TTS 未返回音频")
                    return
            except Exception as e:
                # concurrent.futures.TimeoutError 的 str(e) 为空，需单独标出，否则日志只剩「失败:」
                import concurrent.futures as _cf

                if isinstance(e, (_cf.TimeoutError, TimeoutError)):
                    detail = f"超时（>{HTTP_TTS_TIMEOUT_S}s）。参考音过长/立体声或与本地文字模型抢 GPU 时常见；建议 8–15s 单声道。"
                else:
                    detail = f"{type(e).__name__}: {e}" if str(e) else type(e).__name__
                log(f"HTTP TTS 失败: {detail}")
                self._json_err(502, f"TTS 合成失败：{detail}")
                return
            billed = int((usage or {}).get("characters") or 0)
            log(
                f"HTTP TTS {time.perf_counter()-t0:.2f}s "
                f"chars={len(list(text))} billed={billed or '-'} "
                f"bytes={len(audio)} mime={mime}"
            )
            self.send_response(200)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(audio)))
            self.send_header("Cache-Control", "no-store")
            if billed > 0:
                self.send_header("X-Tts-Usage-Characters", str(billed))
                provider = str((usage or {}).get("provider") or "").strip()
                if provider:
                    self.send_header("X-Tts-Usage-Provider", provider)
            self.end_headers()
            self.wfile.write(audio)

        def _json_err(self, status: int, msg: str) -> None:
            data = json.dumps({"error": msg}, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    server = ThreadingHTTPServer(("127.0.0.1", http_port), Handler)
    t = threading.Thread(target=server.serve_forever, name=f"tts-http-{http_port}", daemon=True)
    t.start()
    log(f"朗读 HTTP http://127.0.0.1:{http_port}/tts")


def pcm16_to_float32(pcm16: bytes):
    """PCM16LE bytes → Whisper 期望的单声道 float32 [-1, 1) 内存数组。"""
    import numpy as np

    usable = memoryview(pcm16)[: len(pcm16) - (len(pcm16) % 2)]
    return np.frombuffer(usable, dtype="<i2").astype(np.float32) / 32768.0


def transcribe(pcm16: bytes) -> tuple[str, float]:
    # mlx-whisper 与 openai-whisper 都原生接受 16k float32 ndarray；
    # 直接走内存，避免每轮创建、写入、重新读取并删除临时 WAV。
    audio = pcm16_to_float32(pcm16)
    if _asr_backend == "mlx":
        import mlx_whisper

        result = mlx_whisper.transcribe(
            audio,
            path_or_hf_repo=WHISPER_MODEL,
            language="zh",
            initial_prompt=WHISPER_PROMPT,
            verbose=False,
        )
        text = (result.get("text") or "").strip()
        nsp = float(result.get("no_speech_prob") or 0.0)
        for seg in result.get("segments") or []:
            nsp = max(nsp, float(seg.get("no_speech_prob") or 0.0))
        return text, nsp
    if _asr_backend == "openai" and _openai_whisper_model is not None:
        result = _openai_whisper_model.transcribe(
            audio,
            language="zh",
            initial_prompt=WHISPER_PROMPT,
            verbose=False,
        )
        text = (result.get("text") or "").strip()
        # openai-whisper 无统一 no_speech_prob，用片段平均近似
        segs = result.get("segments") or []
        if segs:
            nsp = sum(float(s.get("no_speech_prob") or 0.0) for s in segs) / len(segs)
        else:
            nsp = 0.0
        return text, nsp
    raise RuntimeError("ASR 未就绪")


def warmup_asr() -> None:
    """启动后预热 ASR，避免第一通电话冷加载模型造成「点了没反应」。

    mlx 路径下 ``load_whisper_on_mlx_thread`` 只做了 ``import mlx_whisper``，真正的权重
    （whisper-large-v3-turbo，约 1.6GB，日志里的 ``Fetching N files`` + 数百帧处理）要到
    首次 ``transcribe()`` 才加载；而 ASR 又跑在单线程的 ``_mlx_pool`` 上，加载期间那通电话
    完全出不了结果。这里在服务就绪后用一段静音空跑一次，把权重与 JIT 预热掉，让首通电话即时响应。

    必须在 ``_mlx_pool`` 线程上执行（与 TTS/ASR 同一 MLX Metal 上下文）；由 ``run()`` 在
    ``start_tts_http`` 之后 ``submit`` 触发，故不阻塞 HTTP /health 与朗读的就绪。
    """
    if _asr_backend == "none":
        return
    try:
        t0 = time.perf_counter()
        silence = b"\x00\x00" * (INPUT_RATE // 2)  # 0.5s 静音
        transcribe(silence)
        log(f"ASR 预热完成 ({time.perf_counter()-t0:.1f}s, backend={_asr_backend})")
    except Exception as e:
        log(f"ASR 预热跳过：{e}")


def is_valid_asr(text: str, no_speech_prob: float, pcm: bytes) -> str | None:
    if no_speech_prob >= NO_SPEECH_PROB_MAX:
        log(f"过滤: no_speech_prob={no_speech_prob:.2f}")
        return None
    text = (text or "").strip()
    if not text:
        return None
    if _HALLUCINATION_RE.search(text):
        log(f"过滤: 幻觉文本 ({len(text)} chars)")
        return None
    cjk = _CJK_RE.findall(text)
    if len(cjk) < MIN_CJK_CHARS:
        log(f"过滤: 汉字过少 ({len(text)} chars)")
        return None
    bare = re.sub(r"[\s\W_]+", "", text, flags=re.UNICODE)
    if len(bare) < MIN_CJK_CHARS:
        return None
    if _FILLER_RE.match(bare):
        log(f"过滤: 填充词 ({len(text)} chars)")
        return None
    if pcm16_rms(pcm) < SPEECH_RMS * 0.55:
        log("过滤: 整段能量过低")
        return None
    return text


def iter_llm_stream(system_role: str, history: list[dict], user_text: str):
    """逐条解析桌面代理 SSE；不产出思维链，也不在 Python 内持有 provider Key。"""
    payload = build_llm_proxy_payload(system_role, history, user_text)
    body = json.dumps(payload).encode("utf-8")
    secret = os.environ.get("KXYY_TTS_SECRET") or ""
    if not secret:
        raise SafeRealtimeError("本地文字代理鉴权未就绪，请从元元桌宠启动语音服务")
    req = urllib.request.Request(
        _ai_proxy_chat_url(),
        data=body,
        headers={
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
            "X-Kxyy-Internal-Secret": secret,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            provider_header = str(resp.headers.get("X-Kxyy-Text-Provider") or "")
            provider = provider_header if provider_header in {"DeepSeek", "Ollama"} else "文字模型"
            thinking = str(resp.headers.get("X-Kxyy-Thinking") or "1") != "0"
            yield {"type": "meta", "provider": provider, "thinking": thinking}
            content_chars = 0
            reasoning_fallback = ""
            for raw_line in resp:
                try:
                    line = raw_line.decode("utf-8").rstrip("\r\n")
                except (AttributeError, UnicodeDecodeError) as e:
                    raise SafeRealtimeError(f"{provider} 返回格式无效") from e
                if not line.startswith("data:"):
                    continue
                raw_data = line[5:].lstrip()
                if not raw_data:
                    continue
                if raw_data == "[DONE]":
                    break
                try:
                    data = json.loads(raw_data)
                except json.JSONDecodeError as e:
                    raise SafeRealtimeError(f"{provider} 返回格式无效") from e
                usage = data.get("usage") or {}
                if usage:
                    prompt = int(usage.get("prompt_tokens") or 0)
                    completion = int(usage.get("completion_tokens") or 0)
                    yield {
                        "type": "usage",
                        "prompt": prompt,
                        "completion": completion,
                        "total": int(usage.get("total_tokens") or (prompt + completion)),
                    }
                choices = data.get("choices") or []
                if not choices:
                    continue
                delta = choices[0].get("delta") or {}
                content = delta.get("content")
                if isinstance(content, str) and content:
                    if content_chars == 0 and content.isspace():
                        continue
                    if content_chars + len(content) > LLM_REPLY_MAX_CHARS:
                        raise SafeRealtimeError("文字模型回复过长，已停止本轮生成")
                    content_chars += len(content)
                    reasoning_fallback = ""
                    yield {"type": "delta", "text": content}
                    continue
                # 只有明确关闭思考且整条流始终没有 content 时，才把 reasoning 当兼容正文。
                # 不能逐 chunk 回退，否则显式 reasoner 可能先播出思维链、随后又播正文。
                reasoning = delta.get("reasoning_content") or delta.get("reasoning")
                if not thinking and isinstance(reasoning, str) and reasoning:
                    remaining = LLM_REPLY_MAX_CHARS - len(reasoning_fallback)
                    if remaining <= 0 or len(reasoning) > remaining:
                        raise SafeRealtimeError("文字模型回复过长，已停止本轮生成")
                    reasoning_fallback += reasoning
            if content_chars == 0 and reasoning_fallback:
                yield {"type": "delta", "text": reasoning_fallback}
    except urllib.error.HTTPError as e:
        if e.code in {401, 403}:
            message = "文字模型鉴权失败，请检查当前服务设置"
        else:
            message = f"文字模型请求失败（HTTP {e.code}）"
        raise SafeRealtimeError(message) from e
    except urllib.error.URLError as e:
        raise SafeRealtimeError("本地文字代理连接失败，请稍后重试") from e


_llm_stream_slots = threading.BoundedSemaphore(LLM_STREAM_MAX_PRODUCERS)
_tts_stream_slots = threading.BoundedSemaphore(TTS_STREAM_MAX_TASKS)


def _put_llm_event(
    out: "queue.Queue[dict]",
    scope: GenerationCancelScope,
    event: dict,
) -> bool:
    while not scope.inactive.is_set():
        try:
            out.put(event, timeout=0.05)
            return True
        except queue.Full:
            continue
    return False


def start_llm_stream_producer(
    system_role: str,
    history: list[dict],
    user_text: str,
    scope: GenerationCancelScope,
    out: "queue.Queue[dict]",
) -> threading.Thread | None:
    """启动最多两个 daemon producer；取消时有界 put 会及时退出，不堆积 executor 任务。"""
    slots = _llm_stream_slots
    if not slots.acquire(blocking=False):
        _put_llm_event(
            out,
            scope,
            {"type": "error", "message": "文字模型仍在结束上一轮请求，请稍后再试"},
        )
        return None

    def produce() -> None:
        try:
            for event in iter_llm_stream(system_role, history, user_text):
                if not _put_llm_event(out, scope, event):
                    return
            _put_llm_event(out, scope, {"type": "done"})
        except Exception as e:
            if scope.active:
                message = (
                    str(e)
                    if isinstance(e, SafeRealtimeError)
                    else "文字模型流式响应失败，请稍后重试"
                )
                _put_llm_event(out, scope, {"type": "error", "message": message})
        finally:
            slots.release()

    thread = threading.Thread(
        target=produce,
        name=f"llm-stream-{scope.generation}",
        daemon=True,
    )
    try:
        thread.start()
    except Exception:
        slots.release()
        raise
    return thread


def _run_scoped_tts(slots, synth: Callable[[str], object], text: str):
    try:
        return synth(text)
    finally:
        slots.release()


def _drain_background_future(done) -> None:
    """外层可先取消；静默取走后台异常，避免把异常正文交给 loop logger。"""
    if done.cancelled():
        return
    try:
        done.exception()
    except (asyncio.CancelledError, Exception):
        pass


class BoundedOrderedTtsPipeline:
    """有界句队列 + 有界并行合成 + 单路有序播放。

    ``synthesize`` 可并行，``play`` 永远按 submit 顺序一次执行一个。pending
    只保留 ``parallelism`` 个合成 task，输入队列另有固定上限，因此即使后句
    先完成也不会形成无界音频结果缓存。生命周期只允许一个 producer 顺序调用
    submit/finish；callback 不得反向调用本 pipeline 的生命周期方法。共享 ASR
    executor 的后端可关闭 playback 期间预取，避免插话识别排在下一句 TTS 之后。
    """

    def __init__(
        self,
        synthesize,
        play,
        *,
        parallelism: int = 1,
        prefetch_while_playing: bool = True,
        queue_max: int = TTS_SENTENCE_QUEUE_MAX,
        max_segments: int = MAX_AUDIO_SEGMENTS_PER_TURN,
    ):
        self.synthesize = synthesize
        self.play = play
        self.parallelism = max(1, min(TTS_PARALLELISM_MAX, int(parallelism)))
        self.prefetch_while_playing = bool(prefetch_while_playing)
        self.queue = asyncio.Queue(maxsize=max(1, int(queue_max)))
        self.max_segments = max(1, int(max_segments))
        self.submitted = 0
        self.closed = False
        self.runner = asyncio.create_task(self._run())

    async def _put(self, item) -> None:
        if self.runner.done():
            self.runner.result()
        put_task = asyncio.create_task(self.queue.put(item))
        try:
            done, _pending = await asyncio.wait(
                {put_task, self.runner},
                return_when=asyncio.FIRST_COMPLETED,
            )
            if self.runner in done and not put_task.done():
                put_task.cancel()
                await asyncio.gather(put_task, return_exceptions=True)
                self.runner.result()
            await put_task
            if self.runner.done():
                self.runner.result()
        except BaseException:
            if not put_task.done():
                put_task.cancel()
                await asyncio.gather(put_task, return_exceptions=True)
            raise

    async def submit(self, sentence: str) -> int:
        if self.closed:
            raise RuntimeError("TTS pipeline is closed")
        if self.submitted >= self.max_segments:
            raise SafeRealtimeError("本轮语音句段过多，已停止播报")
        self.submitted += 1
        sequence = self.submitted
        await self._put((sequence, sentence))
        return sequence

    async def finish(self) -> None:
        if not self.closed:
            self.closed = True
            await self._put(None)
        await self.runner

    async def cancel(self) -> None:
        self.closed = True
        if not self.runner.done():
            self.runner.cancel()
        await asyncio.gather(self.runner, return_exceptions=True)

    async def _run(self) -> None:
        pending: list[tuple[int, str, asyncio.Task]] = []
        input_task: asyncio.Task | None = None
        playback_task: asyncio.Task | None = None
        input_closed = False
        try:
            while True:
                if (
                    not input_closed
                    and input_task is None
                    and len(pending) < self.parallelism
                    and (playback_task is None or self.prefetch_while_playing)
                ):
                    input_task = asyncio.create_task(self.queue.get())

                if playback_task is None and pending and pending[0][2].done():
                    sequence, sentence, synth_task = pending.pop(0)
                    result = synth_task.result()
                    playback_task = asyncio.create_task(
                        self.play(sequence, sentence, result)
                    )
                    continue

                if input_closed and not pending and playback_task is None:
                    return

                waits: set[asyncio.Task] = set()
                if input_task is not None:
                    waits.add(input_task)
                if playback_task is not None:
                    waits.add(playback_task)
                elif pending:
                    waits.add(pending[0][2])
                if not waits:
                    raise RuntimeError("TTS pipeline lost its wake source")

                done, _pending = await asyncio.wait(
                    waits,
                    return_when=asyncio.FIRST_COMPLETED,
                )
                if input_task is not None and input_task in done:
                    item = input_task.result()
                    input_task = None
                    if item is None:
                        input_closed = True
                    else:
                        sequence, sentence = item
                        pending.append(
                            (
                                sequence,
                                sentence,
                                asyncio.create_task(
                                    self.synthesize(sequence, sentence)
                                ),
                            )
                        )
                if playback_task is not None and playback_task in done:
                    playback_task.result()
                    playback_task = None
        finally:
            cleanup: list[asyncio.Task] = []
            if input_task is not None:
                input_task.cancel()
                cleanup.append(input_task)
            if playback_task is not None:
                playback_task.cancel()
                cleanup.append(playback_task)
            for _sequence, _sentence, synth_task in pending:
                synth_task.cancel()
                cleanup.append(synth_task)
            if cleanup:
                await asyncio.gather(*cleanup, return_exceptions=True)


def chunk_pcm(pcm: bytes, ms: int = 80):
    bytes_per = OUTPUT_RATE * 2 * ms // 1000
    for i in range(0, len(pcm), bytes_per):
        yield pcm[i : i + bytes_per]


def mp3_to_pcm24k(mp3: bytes) -> bytes:
    import subprocess

    try:
        proc = subprocess.run(
            [
                _ffmpeg_cmd(),
                "-v",
                "error",
                "-i",
                "pipe:0",
                "-ac",
                "1",
                "-ar",
                str(OUTPUT_RATE),
                "-f",
                "s16le",
                "pipe:1",
            ],
            input=mp3,
            capture_output=True,
            check=True,
            timeout=30,
            **_subprocess_no_window(),
        )
    except subprocess.TimeoutExpired as e:
        raise RuntimeError("ffmpeg 转码超时") from e
    return proc.stdout


class Session:
    def __init__(self, ws):
        self.ws = ws
        self.system_role = "你是元元，口语化简短回复，一两句即可。"
        self.bot_name = "元元"
        self._audible_history = AudibleHistory()
        # 兼容现有诊断/测试读取；其中 assistant 永远只含前端确认播完的句段。
        self.history = self._audible_history.messages
        self.pcm_buf = bytearray()
        self.speech_pcm = bytearray()
        self.in_speech = False
        self.silence_ms = 0
        self.speech_ms = 0
        self.endpoint = SoftEndpoint()
        self.asr_started = False
        self.barge_loud_frames = 0
        self.gen_id = 0
        self.asr_scope: GenerationCancelScope | None = None
        self.response_scope: GenerationCancelScope | None = None
        self.reply_task: asyncio.Task | None = None
        self.play_enabled = False
        self.playing = False
        # 播报中正在旁路采集候选打断（后端不停播；前端会 duck 并暂停消费）
        self.play_barge_pending = False
        self.candidate_emitted = False
        self.closed = False
        self.loop = asyncio.get_event_loop()
        # LLM delta 与有序音频 sender 可并行推进，但同一 WebSocket 只允许一个 send 在途。
        self._send_lock = asyncio.Lock()
        self.asr_task: asyncio.Task | None = None
        self.tts_parallelism = _tts_parallelism
        self.tts_prefetch_while_playing = _tts_prefetch_while_playing

    def _busy(self) -> bool:
        return self.reply_task is not None and not self.reply_task.done()

    def _new_scope(self, stage: str) -> GenerationCancelScope:
        self.gen_id += 1
        return GenerationCancelScope(self.gen_id, stage)

    async def send_json(
        self,
        obj: dict,
        *,
        scope: GenerationCancelScope | None = None,
    ) -> bool:
        if self.closed or (scope is not None and not scope.active):
            return False
        payload = dict(obj)
        if scope is not None:
            payload["generation"] = scope.generation
        async with self._send_lock:
            if self.closed or (scope is not None and not scope.active):
                return False
            await self.ws.send(json.dumps(payload, ensure_ascii=False))
        return not self.closed and (scope is None or scope.active)

    async def send_pcm(
        self,
        pcm: bytes,
        *,
        scope: GenerationCancelScope | None = None,
    ) -> bool:
        if self.closed or not pcm or (scope is not None and not scope.active):
            return False
        async with self._send_lock:
            if self.closed or (scope is not None and not scope.active):
                return False
            await self.ws.send(pcm)
        return not self.closed and (scope is None or scope.active)

    def _invalidate_play(self) -> None:
        self.play_enabled = False

    async def cancel_reply(self, reason: str = "superseded") -> None:
        scope = self.response_scope
        self.response_scope = None
        if scope is not None:
            self._audible_history.cancel_turn(scope.generation)
            scope.cancel(reason)
        self.play_enabled = False
        self.playing = False
        t = self.reply_task
        self.reply_task = None
        if t and not t.done():
            t.cancel()
            try:
                await t
            except asyncio.CancelledError:
                pass

    async def cancel_asr(self, reason: str = "superseded") -> None:
        scope = self.asr_scope
        self.asr_scope = None
        if scope is not None:
            scope.cancel(reason)
        t = self.asr_task
        self.asr_task = None
        if t and not t.done():
            t.cancel()
            try:
                await t
            except asyncio.CancelledError:
                pass

    async def cancel_all(self, reason: str) -> None:
        await self.cancel_asr(reason)
        await self.cancel_reply(reason)

    async def on_start(self, msg: dict) -> None:
        self.system_role = (msg.get("systemRole") or self.system_role).strip() or self.system_role
        self.bot_name = (msg.get("botName") or "元元").strip() or "元元"
        await self.send_json({"type": "session", "state": "started"})
        log(f"会话开始 bot={self.bot_name} system_role={len(self.system_role)} chars")

    def on_playback_segment(self, msg: dict) -> None:
        """接收前端实际播放回执；只接受有界 ledger 中已知的句段。"""
        generation = msg.get("generation")
        segment_id = msg.get("segmentId")
        state = msg.get("state")
        if (
            not isinstance(generation, int)
            or isinstance(generation, bool)
            or generation < 0
            or not isinstance(segment_id, int)
            or isinstance(segment_id, bool)
            or segment_id < 1
            or state != "completed"
        ):
            return
        self._audible_history.acknowledge(generation, segment_id, state)

    async def on_pcm(self, data: bytes) -> None:
        self.pcm_buf.extend(data)
        frame_bytes = FRAME_SAMPLES * 2
        while len(self.pcm_buf) >= frame_bytes:
            frame = bytes(self.pcm_buf[:frame_bytes])
            del self.pcm_buf[:frame_bytes]
            await self._on_frame(frame)

    async def _emit_asr_start(
        self,
        scope: GenerationCancelScope | None = None,
    ) -> None:
        if self.asr_started:
            return
        if await self.send_json({"type": "asr_start"}, scope=scope):
            self.asr_started = True

    async def _emit_asr_end_only(
        self,
        scope: GenerationCancelScope | None = None,
    ) -> None:
        if scope is not None and not scope.active:
            return
        if self.asr_started:
            await self.send_json({"type": "asr_end"}, scope=scope)
        self.asr_started = False

    async def _emit_speech_candidate(self) -> None:
        if self.candidate_emitted:
            return
        self.candidate_emitted = True
        await self.send_json({"type": "speech_candidate"})

    async def _emit_speech_confirmed(
        self,
        scope: GenerationCancelScope | None = None,
    ) -> None:
        if scope is not None and not scope.active:
            return
        if not self.candidate_emitted:
            return
        self.candidate_emitted = False
        await self.send_json({"type": "speech_confirmed"}, scope=scope)

    async def _emit_speech_rejected(
        self,
        scope: GenerationCancelScope | None = None,
    ) -> None:
        if scope is not None and not scope.active:
            return
        if not self.candidate_emitted:
            return
        self.candidate_emitted = False
        await self.send_json(
            {"type": "speech_rejected", "reason": "voice_rejected"},
            scope=scope,
        )

    async def _on_frame(self, frame: bytes) -> None:
        rms = pcm16_rms(frame)
        busy = self._busy() or self.playing
        # AI 正在出声：用更严门槛，且确认前不停播（避免杂音触发前端 flush）
        while_playing = self.playing and self.play_enabled

        if busy:
            loud_thr = BARGE_IN_RMS_PLAY if while_playing else BARGE_IN_RMS
            need_frames = BARGE_IN_FRAMES_PLAY if while_playing else BARGE_IN_FRAMES
            if rms >= loud_thr:
                self.barge_loud_frames += 1
            else:
                self.barge_loud_frames = max(0, self.barge_loud_frames - 1)

            if not self.in_speech:
                if self.barge_loud_frames >= need_frames or (
                    not while_playing and not self.playing and rms >= SPEECH_RMS
                ):
                    self.in_speech = True
                    self.speech_pcm = bytearray(frame)
                    self.speech_ms = FRAME_MS
                    self.silence_ms = 0
                    self.endpoint.reset()
                    # 忙碌期（合成中或播报中）一律走「旁路采集」：不停播，
                    # 且在 ASR 验证通过前绝不发 asr_start。否则外放余音/杂音
                    # 只要够长就会误触发 asr_start，让前端把「已排队的整段回复」
                    # flush 掉——因为后端是超速灌音频，一 flush 就是后半句全没。
                    self.play_barge_pending = True
                    await self._emit_speech_candidate()
                    log(
                        "播报中检测到疑似人声（旁路采集，待确认）"
                        if while_playing
                        else "合成中检测到疑似人声（旁路采集，待确认）"
                    )
                return

        if not self.in_speech:
            if rms >= SPEECH_RMS:
                self.in_speech = True
                self.speech_pcm = bytearray(frame)
                self.speech_ms = FRAME_MS
                self.silence_ms = 0
                self.endpoint.reset()
            return

        self.speech_pcm.extend(frame)
        self.speech_ms += FRAME_MS

        min_ms = MIN_SPEECH_MS_PLAY if self.play_barge_pending else MIN_SPEECH_MS
        # 播报中旁路采集：确认前绝不发 asr_start（前端会清空播放队列）
        if not self.play_barge_pending and self.speech_ms >= min_ms:
            await self._emit_asr_start()

        if self.play_barge_pending:
            thresh = BARGE_IN_RMS_PLAY * 0.65
        elif busy:
            thresh = BARGE_IN_RMS * 0.7
        else:
            thresh = SPEECH_RMS
        silence_before = self.endpoint.silence_ms
        endpoint_event = self.endpoint.observe(
            rms >= thresh,
            eligible=self.speech_ms >= min_ms,
        )
        self.silence_ms = self.endpoint.silence_ms
        if endpoint_event:
            observed_silence = (
                silence_before if endpoint_event == "reopened" else self.silence_ms
            )
            await self.send_json(
                {
                    "type": f"endpoint_{endpoint_event}",
                    "silenceMs": observed_silence,
                }
            )

        if self.speech_ms >= MAX_SPEECH_MS or endpoint_event == "committed":
            pcm = bytes(self.speech_pcm)
            was_play_barge = self.play_barge_pending
            self.in_speech = False
            self.speech_pcm.clear()
            self.silence_ms = 0
            self.speech_ms = 0
            self.endpoint.reset()
            self.barge_loud_frames = 0
            self.play_barge_pending = False
            await self._handle_utterance(pcm, from_play_barge=was_play_barge)

    async def _resume_play_if_paused(self) -> None:
        if self.playing and not self.play_enabled and self._busy():
            log("误打断，恢复播报")
            self.play_enabled = True

    async def _handle_utterance(self, pcm: bytes, *, from_play_barge: bool = False) -> None:
        min_ms = MIN_SPEECH_MS_PLAY if from_play_barge else MIN_SPEECH_MS
        min_bytes = INPUT_RATE * 2 * min_ms // 1000
        min_rms = SPEECH_RMS * (0.7 if from_play_barge else 0.5)
        if len(pcm) < min_bytes or pcm16_rms(pcm) < min_rms:
            log("丢弃: 片段过短/过静" + ("（播报未中断）" if from_play_barge else ""))
            # 无条件恢复：旁路采集期若回复开始时 in_speech 为真，play_enabled
            # 会被置 False；此处必须放开，否则发送循环永久卡住（幂等，安全）。
            await self._emit_asr_end_only()
            await self._emit_speech_rejected()
            await self._resume_play_if_paused()
            return

        await self.cancel_asr("superseded")
        scope = self._new_scope("asr")
        self.asr_scope = scope
        self.asr_task = asyncio.create_task(
            self._asr_then_maybe_reply(
                pcm,
                scope,
                from_play_barge=from_play_barge,
            )
        )

    async def _asr_then_maybe_reply(
        self,
        pcm: bytes,
        scope: GenerationCancelScope,
        *,
        from_play_barge: bool = False,
    ) -> None:
        try:
            t0 = time.perf_counter()
            text, nsp = await self.loop.run_in_executor(_mlx_pool, transcribe, pcm)
            if not scope.active:
                log(f"丢弃过期 ASR 结果 gen={scope.generation}")
                return
            log(f"ASR {time.perf_counter()-t0:.2f}s nsp={nsp:.2f} chars={len(text)}")
            cleaned = is_valid_asr(text, nsp, pcm)
            if not cleaned:
                log("无效人声，忽略" + ("（播报未中断）" if from_play_barge else ""))
                await self._emit_asr_end_only(scope)
                await self._emit_speech_rejected(scope)
                await self._resume_play_if_paused()
                scope.complete()
                return

            # 此时才真正打断：先停播并通知前端 flush
            if from_play_barge or self.playing:
                log("确认打断播报")
                self._invalidate_play()
            await self._emit_speech_confirmed(scope)
            await self._emit_asr_start(scope)
            await self.send_json(
                {"type": "asr", "text": cleaned, "interim": False},
                scope=scope,
            )
            await self.send_json({"type": "asr_end"}, scope=scope)
            self.asr_started = False
            if not scope.active:
                return

            await self.cancel_reply("turn_detected")
            if not scope.active:
                return
            scope.promote("response")
            if self.asr_scope is scope:
                self.asr_scope = None
            self.response_scope = scope
            self.reply_task = asyncio.create_task(self._reply_pipeline(cleaned, scope))
        except asyncio.CancelledError:
            if scope.active:
                await self._emit_asr_end_only(scope)
                await self._emit_speech_rejected(scope)
                await self._resume_play_if_paused()
                scope.cancel("task_cancelled")
            raise
        except Exception as e:
            if scope.active:
                log(f"ASR 失败: {e}")
                await self._emit_asr_end_only(scope)
                await self._emit_speech_rejected(scope)
                await self._resume_play_if_paused()
                await self.send_json(
                    {"type": "error", "message": str(e)},
                    scope=scope,
                )
                scope.cancel("asr_error")
        finally:
            if self.asr_task is asyncio.current_task():
                self.asr_task = None
            if self.asr_scope is scope and scope.stage == "asr":
                self.asr_scope = None

    async def _reply_pipeline(
        self,
        text: str,
        scope: GenerationCancelScope,
    ) -> None:
        sentences = StableSentenceBuffer()
        tts_pipeline: BoundedOrderedTtsPipeline | None = None
        try:
            assert _synth_tts is not None
            t1 = time.perf_counter()
            history_snapshot = self._audible_history.begin_turn(scope.generation, text)
            events: "queue.Queue[dict]" = queue.Queue(maxsize=LLM_STREAM_QUEUE_MAX)
            start_llm_stream_producer(
                self.system_role,
                history_snapshot,
                text,
                scope,
                events,
            )
            reply_parts: list[str] = []
            reply_chars = 0
            llm_usage = {"prompt": 0, "completion": 0, "total": 0}
            llm_provider = "文字模型"
            tts_chars = 0
            tts_provider = ""
            tts_started = False
            speaking_sent = False
            segment_seq = 0

            async def synthesize_sentence(_sequence: int, sentence: str) -> dict:
                if not sentence or not scope.active:
                    return {"audio": b"", "billed": 0, "provider": "", "spoken": ""}
                tts_slots = _tts_stream_slots
                if not tts_slots.acquire(blocking=False):
                    raise SafeRealtimeError("语音合成仍在结束上一轮请求，请稍后再试")
                pool = _tts_pool if _tts_pool is not None else _mlx_pool
                try:
                    future = self.loop.run_in_executor(
                        pool,
                        _run_scoped_tts,
                        tts_slots,
                        _synth_tts,
                        sentence,
                    )
                    future.add_done_callback(_drain_background_future)
                except Exception:
                    tts_slots.release()
                    raise
                t2 = time.perf_counter()
                try:
                    # asyncio.wait 被取消时不会取消集合里的 executor future；后台合成仍能在
                    # finally 释放 slot，且不会触发 Python 3.14 shield 的强制异常日志。
                    done, _pending = await asyncio.wait({future})
                    tts_result = next(iter(done)).result()
                except asyncio.CancelledError:
                    raise
                except Exception as e:
                    raise SafeRealtimeError("语音合成失败，请稍后重试") from e
                billed = 0
                provider = ""
                if isinstance(tts_result, tuple):
                    audio = tts_result[0]
                    extra = tts_result[1] if len(tts_result) > 1 else None
                    if isinstance(extra, dict):
                        billed = int(extra.get("characters") or 0)
                        provider = str(extra.get("provider") or "").strip()
                    elif isinstance(extra, (int, float)):
                        billed = int(extra)
                else:
                    audio = tts_result
                audio_bytes = (
                    len(audio)
                    if isinstance(audio, (bytes, bytearray, memoryview))
                    else 0
                )
                log(
                    f"TTS sentence {time.perf_counter()-t2:.2f}s "
                    f"({audio_bytes} bytes, billed={billed or '-'})"
                )
                if not scope.active:
                    log(f"丢弃过期 TTS gen={scope.generation}")
                    return {"audio": b"", "billed": 0, "provider": "", "spoken": ""}
                if not audio:
                    return {
                        "audio": b"",
                        "billed": billed,
                        "provider": provider,
                        "spoken": "",
                    }
                if not isinstance(audio, (bytes, bytearray, memoryview)):
                    raise SafeRealtimeError("语音合成返回了无效音频，请稍后重试")
                if audio_bytes % 2 != 0:
                    raise SafeRealtimeError("语音合成返回了无效音频，请稍后重试")
                if audio_bytes // 2 > TTS_SENTENCE_MAX_SAMPLES:
                    raise SafeRealtimeError("单句语音过长，已停止播报")
                spoken_sentence = clip_speech_text(
                    text_for_speech(sentence) or sentence.strip()
                )
                return {
                    "audio": bytes(audio),
                    "billed": billed,
                    "provider": provider,
                    "spoken": spoken_sentence,
                }

            async def play_sentence(_sequence: int, _sentence: str, result: dict) -> None:
                nonlocal tts_chars, tts_provider, speaking_sent, segment_seq
                if not scope.active:
                    return
                audio = result["audio"]
                billed = int(result["billed"] or 0)
                provider = str(result["provider"] or "").strip()
                spoken_sentence = str(result["spoken"] or "")
                tts_chars += billed
                if provider:
                    tts_provider = provider
                if not audio or not spoken_sentence:
                    return
                segment_seq += 1
                segment_id = segment_seq
                if not self._audible_history.add_segment(
                    scope.generation,
                    segment_id,
                    spoken_sentence,
                ):
                    raise SafeRealtimeError("本轮语音句段过多，已停止播报")
                if not await self.send_json(
                    {
                        "type": "audio_segment_start",
                        "segmentId": segment_id,
                        "text": spoken_sentence,
                        "samples": len(audio) // 2,
                    },
                    scope=scope,
                ):
                    return
                self.playing = True
                if not speaking_sent:
                    self.play_enabled = not self.in_speech
                    if not self.play_enabled:
                        log("用户仍在说话，暂缓播报")
                    if not await self.send_json({"type": "speaking"}, scope=scope):
                        return
                    speaking_sent = True
                for chunk in chunk_pcm(audio, 80):
                    if not scope.active:
                        log("播报被新话术取代")
                        return
                    while not self.play_enabled and scope.active:
                        await asyncio.sleep(0.02)
                    if not scope.active or not await self.send_pcm(chunk, scope=scope):
                        return
                    await asyncio.sleep(0.06)
                await self.send_json(
                    {"type": "audio_segment_end", "segmentId": segment_id},
                    scope=scope,
                )

            async def enqueue_sentence(sentence: str) -> None:
                nonlocal tts_started
                if not sentence or not scope.active:
                    return
                if not tts_started:
                    if not await self.send_json({"type": "tts_start"}, scope=scope):
                        return
                    tts_started = True
                assert tts_pipeline is not None
                await tts_pipeline.submit(sentence)

            tts_pipeline = BoundedOrderedTtsPipeline(
                synthesize_sentence,
                play_sentence,
                parallelism=self.tts_parallelism,
                prefetch_while_playing=self.tts_prefetch_while_playing,
            )

            stream_done = False
            while scope.active and not stream_done:
                try:
                    event = events.get_nowait()
                except queue.Empty:
                    await asyncio.sleep(0.01)
                    continue
                event_type = event.get("type")
                if event_type == "meta":
                    llm_provider = str(event.get("provider") or "文字模型")
                elif event_type == "usage":
                    llm_usage = {
                        "prompt": int(event.get("prompt") or 0),
                        "completion": int(event.get("completion") or 0),
                        "total": int(event.get("total") or 0),
                    }
                elif event_type == "delta":
                    delta = str(event.get("text") or "")
                    if not delta:
                        continue
                    if reply_chars + len(delta) > LLM_REPLY_MAX_CHARS:
                        raise SafeRealtimeError("文字模型回复过长，已停止本轮生成")
                    reply_parts.append(delta)
                    reply_chars += len(delta)
                    if not await self.send_json(
                        {"type": "assistant", "text": delta},
                        scope=scope,
                    ):
                        return
                    for sentence in sentences.feed(delta):
                        await enqueue_sentence(sentence)
                elif event_type == "error":
                    raise SafeRealtimeError(
                        str(event.get("message") or "文字模型请求失败")
                    )
                elif event_type == "done":
                    stream_done = True

            if not scope.active:
                return
            reply = "".join(reply_parts).strip()
            log(
                f"LLM {time.perf_counter()-t1:.2f}s "
                f"tok={llm_usage.get('total', 0)} chars={len(reply or '')}"
            )
            if not reply:
                return

            if not await self.send_json({"type": "assistant_end"}, scope=scope):
                return

            for sentence in sentences.flush():
                await enqueue_sentence(sentence)

            await tts_pipeline.finish()

            if tts_started:
                await self.send_json({"type": "tts_end"}, scope=scope)

            # 本轮用量：当前文字 provider token +（若有）云端 TTS 计费字符。
            provider = llm_provider
            if tts_chars > 0:
                provider = f"{llm_provider}+{tts_provider or _log_prefix or 'TTS'}"
            await self.send_json(
                {
                    "type": "usage",
                    "provider": provider,
                    "estimated": False,
                    "llm": llm_usage,
                    "ttsCharacters": tts_chars,
                    "total": int(llm_usage.get("total") or 0),
                },
                scope=scope,
            )
        except asyncio.CancelledError:
            sentences.cancel()
            raise
        except Exception as e:
            if scope.active:
                message = (
                    str(e)
                    if isinstance(e, SafeRealtimeError)
                    else "本地实时语音处理失败，请稍后重试"
                )
                log(f"回复失败: {type(e).__name__}")
                await self.send_json(
                    {"type": "error", "message": message},
                    scope=scope,
                )
                scope.cancel("response_error")
        finally:
            if tts_pipeline is not None:
                await tts_pipeline.cancel()
            if self.reply_task is asyncio.current_task():
                self.reply_task = None
            if self.response_scope is scope:
                self.playing = False
                self.play_enabled = False
                self.response_scope = None
                scope.complete()


async def _handler(ws):
    session = Session(ws)
    log("客户端已连接")
    try:
        async for message in ws:
            if isinstance(message, bytes):
                await session.on_pcm(message)
                continue
            try:
                msg = json.loads(message)
            except json.JSONDecodeError:
                continue
            typ = msg.get("type")
            if typ == "start":
                await session.on_start(msg)
            elif typ == "hangup":
                await session.cancel_all("hangup")
                await session.send_json({"type": "session", "state": "ended"})
                break
            elif typ == "playback_segment":
                session.on_playback_segment(msg)
    except Exception as e:
        log(f"连接结束: {e}")
    finally:
        session.closed = True
        await session.cancel_all("disconnect")
        log("客户端断开")


def run(
    *,
    port: int,
    name: str,
    synth_tts: Callable[[str], bytes],
    prepare,
    tts_pool: Executor | None = None,
    tts_parallelism: int = 1,
    tts_prefetch_while_playing: bool = False,
    system_suffix: str = "",
    synth_tts_http: Callable[[str], tuple] | None = None,
) -> None:
    """prepare() 在监听前调用（加载模型等）。"""
    global _log_prefix, _synth_tts, _synth_tts_http, _tts_pool
    global _tts_parallelism, _tts_prefetch_while_playing, _system_suffix
    _log_prefix = name
    _synth_tts = synth_tts
    _synth_tts_http = synth_tts_http
    _tts_pool = tts_pool
    _tts_parallelism = max(1, min(TTS_PARALLELISM_MAX, int(tts_parallelism)))
    _tts_prefetch_while_playing = bool(tts_prefetch_while_playing)
    _system_suffix = system_suffix

    try:
        import websockets
    except ImportError as e:
        raise SystemExit("缺少 websockets：在 voice-ab/.venv 里 pip install websockets") from e

    load_llm_settings()
    _ensure_cli_path()
    prepare()
    start_tts_http(port)
    # HTTP /health 与朗读已就绪，再后台预热 ASR：首通电话不必等 whisper 冷加载。
    _mlx_pool.submit(warmup_asr)
    log(f"监听 ws://127.0.0.1:{port}")

    async def main_async() -> None:
        async with websockets.serve(_handler, "127.0.0.1", port, max_size=8 * 1024 * 1024):
            await asyncio.Future()

    try:
        asyncio.run(main_async())
    except KeyboardInterrupt:
        log("退出")
