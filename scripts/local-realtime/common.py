#!/usr/bin/env python3
"""本地实时语音对话：共享协议 / VAD / ASR / LLM / 打断逻辑。

各入口（server.py / server_cosyvoice.py / server_cosyvoice3_local.py / server_indextts2.py）负责加载 TTS，并调用 run(port, name)。
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import ssl
import struct
import sys
import tempfile
import time
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


def _ref_candidates() -> list[Path]:
    paths: list[Path] = []
    if _RUNTIME is not None:
        paths.append(_RUNTIME / "out" / "kxyy-wechat-record-cut01_30s.wav")
    paths.append(ROOT / "assets" / "kxyy-wechat-record-cut01_30s.wav")
    paths.append(VOICE_AB / "out" / "kxyy-wechat-record-cut01_30s.wav")
    return paths


def ref_wav_path() -> Path:
    for p in _ref_candidates():
        if p.is_file():
            return p
    if _RUNTIME is not None:
        return _RUNTIME / "out" / "kxyy-wechat-record-cut01_30s.wav"
    return VOICE_AB / "out" / "kxyy-wechat-record-cut01_30s.wav"


def ref_txt_path() -> Path:
    wav = ref_wav_path()
    return wav.with_suffix(".txt")


REF_WAV = VOICE_AB / "out" / "kxyy-wechat-record-cut01_30s.wav"  # 兼容旧引用；运行时请用 ref_wav_path()
REF_TXT = VOICE_AB / "out" / "kxyy-wechat-record-cut01_30s.txt"
MERGED_MP3 = REPO / "merged.mp3"

# 内置兜底参考音文案（与 assets/kxyy-wechat-record-cut01_30s.txt 一致）。
# 当用户未填写文案、且同名 .txt 也找不到时使用。
_DEFAULT_REF_TEXT = (
    "对的，这是先实验一个小聚会，然后这个要是成功了的话，咱们之后就可以再换一个地方，"
    "然后之后咱们办一个稍微大一点的，然后去的可以稍微多一点，因为现在太敏感了。"
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
# 句尾静音多久算「说完」：过短会打断思考停顿，过长则回复变慢。
# 2s 适合边想边说；若仍觉得抢话可再调到 2500。
SILENCE_END_MS = 2000
MIN_SPEECH_MS = 500
# 单句最长录音（安全阀，防异常一直录）。日常聊天够用；真要长独白可再加大。
MAX_SPEECH_MS = 60000
# 空闲态打断门槛
BARGE_IN_RMS = 0.022
BARGE_IN_FRAMES = 6
# AI 播报中：更高更久才采信（防外放漏音/杂音）；确认前不停播、不发 asr_start
BARGE_IN_RMS_PLAY = 0.04
BARGE_IN_FRAMES_PLAY = 12  # ~360ms
MIN_SPEECH_MS_PLAY = 800
NO_SPEECH_PROB_MAX = 0.55
MIN_CJK_CHARS = 2

WHISPER_MODEL = "mlx-community/whisper-large-v3-turbo"
DEEPSEEK_URL = "https://api.deepseek.com/chat/completions"
WHISPER_PROMPT = "以下是一段中文对话，角色名叫元元。"

_CJK_RE = re.compile(r"[\u4e00-\u9fff]")
_FILLER_RE = re.compile(
    r"^(嗯+|啊+|呃+|哦+|噢+|唔+|恩+|嘿+|欸+|唉+|那个|这|啊哈|哈哈+|嘿嘿+)+$"
)
_HALLUCINATION_RE = re.compile(r"字幕|订阅|点赞|鸣谢|翻译|thanks for watching", re.I)

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
_deepseek_key = ""
_temperature = 0.8
_system_suffix = ""


def log(msg: str) -> None:
    print(f"[{_log_prefix}] {msg}", flush=True)


def load_settings() -> dict:
    if not SETTINGS.exists():
        return {}
    return json.loads(SETTINGS.read_text(encoding="utf-8"))


def _user_ref_from_settings() -> "tuple[Path | None, str]":
    """读取用户在设置里填写的参考音路径 / 文案（localRefWav / localRefText）。

    发行版不再内置任何真人录音，改由用户自备参考音；此项为本地克隆音色的唯一来源。
    路径为空 → 返回 (None, 文案)，交给后续默认查找（仅开发环境有内置样本时才命中）。
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


def ensure_ref_wav() -> tuple[Path, str]:
    # 优先使用用户在「设置 → 语音 → 参考音频」填写的录音。
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
            text = _DEFAULT_REF_TEXT
        return user_wav, text

    wav = ref_wav_path()
    txt = ref_txt_path()
    if wav.is_file():
        text = txt.read_text(encoding="utf-8").strip() if txt.is_file() else ""
        if not text:
            text = _DEFAULT_REF_TEXT
        return wav, text

    # 打包资源里的参考音（只读）→ 复制到 runtime/out
    bundled = ROOT / "assets" / "kxyy-wechat-record-cut01_30s.wav"
    bundled_txt = ROOT / "assets" / "kxyy-wechat-record-cut01_30s.txt"
    if bundled.is_file():
        dest = (
            (_RUNTIME / "out" / "kxyy-wechat-record-cut01_30s.wav")
            if _RUNTIME is not None
            else (VOICE_AB / "out" / "kxyy-wechat-record-cut01_30s.wav")
        )
        dest.parent.mkdir(parents=True, exist_ok=True)
        if not dest.is_file():
            dest.write_bytes(bundled.read_bytes())
        dest_txt = dest.with_suffix(".txt")
        if bundled_txt.is_file() and not dest_txt.is_file():
            dest_txt.write_bytes(bundled_txt.read_bytes())
        text = (
            dest_txt.read_text(encoding="utf-8").strip()
            if dest_txt.is_file()
            else _DEFAULT_REF_TEXT
        )
        return dest, text

    # 走到这里说明内置兜底参考音也找不到（安装包资源缺失 / 仓库被裁剪）。
    # 不再 fallback 到 merged.mp3 截取（该文件被 gitignore，dev / 发行版均无），
    # 直接报错并引导用户自行填入参考音频。
    raise SystemExit(
        "未找到参考音频。请在「设置 → 语音 → 参考音频」填入一段清晰的单人录音"
        "（建议 10~20s，wav/mp3 均可），保存后重启语音服务即可克隆该音色。"
    )


def load_llm_settings() -> None:
    global _deepseek_key, _temperature
    s = load_settings()
    _deepseek_key = (s.get("deepseekKey") or "").strip()
    if not _deepseek_key:
        raise SystemExit("settings.json 未配置 deepseekKey（本地对话的 LLM）")
    _temperature = float(s.get("temperature") or 0.8)


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
                log(f"HTTP TTS 失败: {e}")
                self._json_err(502, f"TTS 合成失败：{e}")
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


def transcribe(pcm16: bytes) -> tuple[str, float]:
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        path = Path(f.name)
    try:
        write_wav(path, pcm16, INPUT_RATE)
        if _asr_backend == "mlx":
            import mlx_whisper

            result = mlx_whisper.transcribe(
                str(path),
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
                str(path),
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
    finally:
        path.unlink(missing_ok=True)


def is_valid_asr(text: str, no_speech_prob: float, pcm: bytes) -> str | None:
    if no_speech_prob >= NO_SPEECH_PROB_MAX:
        log(f"过滤: no_speech_prob={no_speech_prob:.2f}")
        return None
    text = (text or "").strip()
    if not text:
        return None
    if _HALLUCINATION_RE.search(text):
        log(f"过滤: 幻觉文本 {text!r}")
        return None
    cjk = _CJK_RE.findall(text)
    if len(cjk) < MIN_CJK_CHARS:
        log(f"过滤: 汉字过少 {text!r}")
        return None
    bare = re.sub(r"[\s\W_]+", "", text, flags=re.UNICODE)
    if len(bare) < MIN_CJK_CHARS:
        return None
    if _FILLER_RE.match(bare):
        log(f"过滤: 填充词 {text!r}")
        return None
    if pcm16_rms(pcm) < SPEECH_RMS * 0.55:
        log("过滤: 整段能量过低")
        return None
    return text


def chat_llm(system_role: str, history: list[dict], user_text: str) -> tuple[str, dict]:
    """返回 (reply_text, usage)；usage 含 prompt/completion/total（DeepSeek）。"""
    role = system_role or "你是元元，口语化简短回复。"
    if _system_suffix:
        role = role + _system_suffix
    messages = [{"role": "system", "content": role}]
    messages.extend(history[-12:])
    messages.append({"role": "user", "content": user_text})
    payload = {
        "model": "deepseek-chat",
        "messages": messages,
        "temperature": _temperature,
        "max_tokens": 200,
        "stream": False,
    }
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        DEEPSEEK_URL,
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {_deepseek_key}",
        },
        method="POST",
    )
    ctx = https_context()
    with urllib.request.urlopen(req, timeout=60, context=ctx) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    text = (data["choices"][0]["message"]["content"] or "").strip()
    u = data.get("usage") or {}
    prompt = int(u.get("prompt_tokens") or 0)
    completion = int(u.get("completion_tokens") or 0)
    total = int(u.get("total_tokens") or (prompt + completion))
    return text, {"prompt": prompt, "completion": completion, "total": total}


def chunk_pcm(pcm: bytes, ms: int = 80):
    bytes_per = OUTPUT_RATE * 2 * ms // 1000
    for i in range(0, len(pcm), bytes_per):
        yield pcm[i : i + bytes_per]


def mp3_to_pcm24k(mp3: bytes) -> bytes:
    import subprocess

    try:
        proc = subprocess.run(
            [
                "ffmpeg",
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
        self.history: list[dict] = []
        self.pcm_buf = bytearray()
        self.speech_pcm = bytearray()
        self.in_speech = False
        self.silence_ms = 0
        self.speech_ms = 0
        self.asr_started = False
        self.barge_loud_frames = 0
        self.gen_id = 0
        self.reply_task: asyncio.Task | None = None
        self.play_enabled = False
        self.playing = False
        # 播报中正在旁路采集候选打断（尚未停播、未通知前端）
        self.play_barge_pending = False
        self.closed = False
        self.loop = asyncio.get_event_loop()
        self.asr_task: asyncio.Task | None = None

    def _busy(self) -> bool:
        return self.reply_task is not None and not self.reply_task.done()

    async def send_json(self, obj: dict) -> None:
        if self.closed:
            return
        await self.ws.send(json.dumps(obj, ensure_ascii=False))

    async def send_pcm(self, pcm: bytes) -> None:
        if self.closed or not pcm:
            return
        await self.ws.send(pcm)

    def _invalidate_play(self) -> None:
        self.play_enabled = False

    async def cancel_reply(self) -> None:
        self.gen_id += 1
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

    async def on_start(self, msg: dict) -> None:
        self.system_role = (msg.get("systemRole") or self.system_role).strip() or self.system_role
        self.bot_name = (msg.get("botName") or "元元").strip() or "元元"
        await self.send_json({"type": "session", "state": "started"})
        log(f"会话开始 bot={self.bot_name} system_role={len(self.system_role)} chars")

    async def on_pcm(self, data: bytes) -> None:
        self.pcm_buf.extend(data)
        frame_bytes = FRAME_SAMPLES * 2
        while len(self.pcm_buf) >= frame_bytes:
            frame = bytes(self.pcm_buf[:frame_bytes])
            del self.pcm_buf[:frame_bytes]
            await self._on_frame(frame)

    async def _emit_asr_start(self) -> None:
        if self.asr_started:
            return
        self.asr_started = True
        await self.send_json({"type": "asr_start"})

    async def _emit_asr_end_only(self) -> None:
        if self.asr_started:
            await self.send_json({"type": "asr_end"})
        self.asr_started = False

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
                    # 忙碌期（合成中或播报中）一律走「旁路采集」：不停播，
                    # 且在 ASR 验证通过前绝不发 asr_start。否则外放余音/杂音
                    # 只要够长就会误触发 asr_start，让前端把「已排队的整段回复」
                    # flush 掉——因为后端是超速灌音频，一 flush 就是后半句全没。
                    self.play_barge_pending = True
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
        if rms < thresh:
            self.silence_ms += FRAME_MS
        else:
            self.silence_ms = 0

        if self.speech_ms >= MAX_SPEECH_MS or (
            self.silence_ms >= SILENCE_END_MS and self.speech_ms >= min_ms
        ):
            pcm = bytes(self.speech_pcm)
            was_play_barge = self.play_barge_pending
            self.in_speech = False
            self.speech_pcm.clear()
            self.silence_ms = 0
            self.speech_ms = 0
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
            await self._resume_play_if_paused()
            return

        if self.asr_task and not self.asr_task.done():
            self.asr_task.cancel()
            try:
                await self.asr_task
            except asyncio.CancelledError:
                pass
        self.asr_task = asyncio.create_task(
            self._asr_then_maybe_reply(pcm, from_play_barge=from_play_barge)
        )

    async def _asr_then_maybe_reply(self, pcm: bytes, *, from_play_barge: bool = False) -> None:
        try:
            t0 = time.perf_counter()
            text, nsp = await self.loop.run_in_executor(_mlx_pool, transcribe, pcm)
            log(f"ASR {time.perf_counter()-t0:.2f}s nsp={nsp:.2f} → {text!r}")
            cleaned = is_valid_asr(text, nsp, pcm)
            if not cleaned:
                log("无效人声，忽略" + ("（播报未中断）" if from_play_barge else ""))
                await self._emit_asr_end_only()
                await self._resume_play_if_paused()
                return

            # 此时才真正打断：先停播并通知前端 flush
            if from_play_barge or self.playing:
                log("确认打断播报")
                self._invalidate_play()
            await self._emit_asr_start()
            await self.send_json({"type": "asr", "text": cleaned, "interim": False})
            await self.send_json({"type": "asr_end"})
            self.asr_started = False

            await self.cancel_reply()
            my_gen = self.gen_id
            self.reply_task = asyncio.create_task(self._reply_pipeline(cleaned, my_gen))
        except asyncio.CancelledError:
            raise
        except Exception as e:
            log(f"ASR 失败: {e}")
            await self._emit_asr_end_only()
            await self._resume_play_if_paused()
            await self.send_json({"type": "error", "message": str(e)})

    async def _reply_pipeline(self, text: str, my_gen: int) -> None:
        assert _synth_tts is not None
        try:
            t1 = time.perf_counter()
            reply, llm_usage = await self.loop.run_in_executor(
                None, chat_llm, self.system_role, list(self.history), text
            )
            log(
                f"LLM {time.perf_counter()-t1:.2f}s "
                f"tok={llm_usage.get('total', 0)} → {reply!r}"
            )
            if my_gen != self.gen_id:
                log(f"丢弃过期 LLM 结果 gen={my_gen}/{self.gen_id}")
                return
            if not reply:
                return

            self.history.append({"role": "user", "content": text})
            self.history.append({"role": "assistant", "content": reply})

            await self.send_json({"type": "assistant", "text": reply})
            await self.send_json({"type": "assistant_end"})

            t2 = time.perf_counter()
            pool = _tts_pool if _tts_pool is not None else _mlx_pool
            tts_result = await self.loop.run_in_executor(pool, _synth_tts, reply)
            tts_chars = 0
            tts_provider = ""
            if isinstance(tts_result, tuple):
                audio = tts_result[0]
                extra = tts_result[1] if len(tts_result) > 1 else None
                if isinstance(extra, dict):
                    tts_chars = int(extra.get("characters") or 0)
                    tts_provider = str(extra.get("provider") or "").strip()
                elif isinstance(extra, (int, float)):
                    tts_chars = int(extra)
            else:
                audio = tts_result
            log(
                f"TTS {time.perf_counter()-t2:.2f}s "
                f"({len(audio)} bytes, billed={tts_chars or '-'})"
            )
            if my_gen != self.gen_id:
                log(f"丢弃过期 TTS gen={my_gen}/{self.gen_id}")
                return

            # 本轮用量：DeepSeek token +（若有）云端 TTS 计费字符。
            provider = "DeepSeek"
            if tts_chars > 0:
                provider = f"DeepSeek+{tts_provider or _log_prefix or 'TTS'}"
            await self.send_json(
                {
                    "type": "usage",
                    "provider": provider,
                    "estimated": False,
                    "llm": llm_usage,
                    "ttsCharacters": tts_chars,
                    "total": int(llm_usage.get("total") or 0),
                }
            )

            if not audio:
                return

            self.playing = True
            self.play_enabled = not self.in_speech
            if not self.play_enabled:
                log("用户仍在说话，暂缓播报")
            await self.send_json({"type": "speaking"})

            for chunk in chunk_pcm(audio, 80):
                if my_gen != self.gen_id:
                    log("播报被新话术取代")
                    break
                while not self.play_enabled and my_gen == self.gen_id:
                    await asyncio.sleep(0.02)
                if my_gen != self.gen_id:
                    break
                await self.send_pcm(chunk)
                # 每片 80ms 音频。发送节奏贴近实时（0.06s，留 ~20ms 提前量抗抖动），
                # 不再把整段回复瞬间灌满前端队列——万一真被打断/flush，也只损失一小段，
                # 而不是「说一半后半句全没」。
                await asyncio.sleep(0.06)

            if my_gen == self.gen_id:
                self.playing = False
                self.play_enabled = False
        except asyncio.CancelledError:
            self.playing = False
            self.play_enabled = False
            raise
        except Exception as e:
            self.playing = False
            self.play_enabled = False
            log(f"回复失败: {e}")
            if my_gen == self.gen_id:
                await self.send_json({"type": "error", "message": str(e)})


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
                await session.cancel_reply()
                if session.asr_task and not session.asr_task.done():
                    session.asr_task.cancel()
                await session.send_json({"type": "session", "state": "ended"})
                break
    except Exception as e:
        log(f"连接结束: {e}")
    finally:
        session.closed = True
        await session.cancel_reply()
        log("客户端断开")


def run(
    *,
    port: int,
    name: str,
    synth_tts: Callable[[str], bytes],
    prepare,
    tts_pool: Executor | None = None,
    system_suffix: str = "",
    synth_tts_http: Callable[[str], tuple] | None = None,
) -> None:
    """prepare() 在监听前调用（加载模型等）。"""
    global _log_prefix, _synth_tts, _synth_tts_http, _tts_pool, _system_suffix
    _log_prefix = name
    _synth_tts = synth_tts
    _synth_tts_http = synth_tts_http
    _tts_pool = tts_pool
    _system_suffix = system_suffix

    try:
        import websockets
    except ImportError as e:
        raise SystemExit("缺少 websockets：在 voice-ab/.venv 里 pip install websockets") from e

    load_llm_settings()
    prepare()
    start_tts_http(port)
    log(f"监听 ws://127.0.0.1:{port}")

    async def main_async() -> None:
        async with websockets.serve(_handler, "127.0.0.1", port, max_size=8 * 1024 * 1024):
            await asyncio.Future()

    try:
        asyncio.run(main_async())
    except KeyboardInterrupt:
        log("退出")
