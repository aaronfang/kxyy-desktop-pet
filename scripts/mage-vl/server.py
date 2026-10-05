#!/usr/bin/env python3
import base64, json, re, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
from importlib import metadata
from pathlib import Path
import tempfile

import cv2

MODEL_ID = "mlx-community/Mage-VL-8bit"
MAX_BYTES = 8 * 1024 * 1024
MAX_VIDEO_BYTES = 96 * 1024 * 1024
MAX_VIDEO_FRAMES = 4
MAX_FRAME_WINDOW_BYTES = 16 * 1024 * 1024
VIDEO_MAX_SIDE = 640
IMAGE_MAX_TOKENS = 64
IMAGE_MAX_SIDE = 640
VIDEO_MAX_TOKENS = 160
IMAGE_QUESTION = "请只描述明确可见的画面内容。不要猜测作品名或角色名；除非画面文字清楚显示名字，否则人物只用外观或身份代称。不确定就少说。"
model = processor = None

def mlx_video_supported(version=None):
    if version is None:
        try:
            version = metadata.version("mlx-vlm")
        except metadata.PackageNotFoundError:
            return False
    match = re.match(r"^(\d+)\.(\d+)\.(\d+)", str(version))
    return bool(match and tuple(map(int, match.groups())) >= (0, 7, 1))

def generate_summary(images, question, max_tokens, *, video_metadata=None):
    global model, processor
    from mlx_vlm import load, generate
    from mlx_vlm.prompt_utils import apply_chat_template
    if model is None:
        model, processor = load(MODEL_ID)
    if video_metadata is not None:
        if not mlx_video_supported():
            raise RuntimeError("Mage-VL frame windows require mlx-vlm>=0.7.1")
        videos = [images]
        prompt = apply_chat_template(processor, model.config, question, video=videos, fps=[2.0])
        return generate(
            model,
            processor,
            prompt,
            video=videos,
            fps=[2.0],
            video_metadata=video_metadata,
            max_tokens=max_tokens,
        ).text
    prompt = apply_chat_template(processor, model.config, question, num_images=len(images))
    return generate(model, processor, prompt, image=images, max_tokens=max_tokens).text

def response(summary, source, *, captured_at_ms=None, **extra):
    now = int(time.time() * 1000)
    captured = int(captured_at_ms if captured_at_ms is not None else now)
    return {
        "status": "ok",
        "provider": "mage-vl",
        "model": MODEL_ID,
        "summary": str(summary).strip()[:900],
        "source": source,
        "capturedAtMs": captured,
        "expiresAtMs": captured + 120000,
        **extra,
    }

def decode_image_data_url(raw, *, jpeg_only=False):
    from PIL import Image
    prefix = "data:image/jpeg;base64," if jpeg_only else "data:image/"
    if not isinstance(raw, str) or not raw.startswith(prefix) or "," not in raw:
        raise ValueError("invalid image")
    try:
        blob = base64.b64decode(raw.split(",", 1)[1], validate=True)
        if not blob or len(blob) > MAX_BYTES:
            raise ValueError("invalid image")
        image = Image.open(BytesIO(blob)).convert("RGB")
        image.thumbnail((IMAGE_MAX_SIDE, IMAGE_MAX_SIDE))
        return image, len(blob)
    except Exception as error:
        raise ValueError("invalid image") from error

def observe(data):
    raw = str(data.get("imageDataUrl", ""))
    image, _ = decode_image_data_url(raw)
    question = str(data.get("question") or IMAGE_QUESTION)[:240]
    return response(generate_summary([image], question, IMAGE_MAX_TOKENS), "image")

def observe_frames(data, *, generate_fn=generate_summary):
    frames = data.get("frames")
    if not isinstance(frames, list) or not 2 <= len(frames) <= MAX_VIDEO_FRAMES:
        raise ValueError("frame window must contain 2 to 4 frames")
    images, timestamps = [], []
    total_bytes = 0
    for frame in frames:
        if not isinstance(frame, dict):
            raise ValueError("invalid frame")
        captured_at_ms = frame.get("capturedAtMs")
        if not isinstance(captured_at_ms, int) or captured_at_ms < 0:
            raise ValueError("invalid frame timestamp")
        if timestamps and captured_at_ms <= timestamps[-1]:
            raise ValueError("frame timestamps must be strictly increasing")
        image, byte_count = decode_image_data_url(frame.get("imageDataUrl"), jpeg_only=True)
        total_bytes += byte_count
        if total_bytes > MAX_FRAME_WINDOW_BYTES:
            raise ValueError("frame window too large")
        timestamps.append(captured_at_ms)
        images.append(image)
    if timestamps[-1] - timestamps[0] > 30_000:
        raise ValueError("frame window duration is too long")
    offsets = [(value - timestamps[0]) / 1000 for value in timestamps]
    indices = []
    for offset in offsets:
        candidate = round(offset * 2)
        indices.append(max(candidate, indices[-1] + 1 if indices else 0))
    video_metadata = [{
        "total_num_frames": indices[-1] + 1,
        "fps": 2.0,
        "frames_indices": indices,
    }]
    offsets_text = "、".join(f"{offset:.1f}秒" for offset in offsets)
    question = str(data.get("question") or "请描述这些按时间排列的画面中明确发生的变化。")[:240]
    question = f"{question}\n各帧相对第一帧的时间为：{offsets_text}。"
    summary = generate_fn(
        images,
        question,
        VIDEO_MAX_TOKENS,
        video_metadata=video_metadata,
    )
    return response(
        summary,
        "frame-window",
        captured_at_ms=timestamps[-1],
        frameCount=len(images),
        windowDurationMs=timestamps[-1] - timestamps[0],
    )

def observe_video(data):
    from PIL import Image
    raw = str(data.get("videoBase64", ""))
    blob = base64.b64decode(raw, validate=True)
    if not blob or len(blob) > MAX_VIDEO_BYTES:
        raise ValueError("invalid or oversized video")
    with tempfile.NamedTemporaryFile(suffix=".mov", delete=False) as handle:
        handle.write(blob)
        video_path = Path(handle.name)
    try:
        capture = cv2.VideoCapture(str(video_path))
        count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
        if count < 2:
            raise ValueError("video has too few frames")
        indices = {round(index * (count - 1) / (MAX_VIDEO_FRAMES - 1)) for index in range(MAX_VIDEO_FRAMES)}
        frames = []
        last_index = max(indices)
        for index in range(last_index + 1):
            ok, frame = capture.read()
            if not ok:
                break
            if index in indices:
                image = Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
                image.thumbnail((VIDEO_MAX_SIDE, VIDEO_MAX_SIDE))
                frames.append(image)
        capture.release()
        if len(frames) < 2:
            raise ValueError("could not extract video frames")
        question = str(data.get("question") or "以下是按时间顺序抽取的短视频画面。请简要讲述你明确看到的内容变化；不确定处直接说明。")[:240]
        return response(generate_summary(frames, question, VIDEO_MAX_TOKENS), "window")
    finally:
        video_path.unlink(missing_ok=True)

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/health":
            self.send_error(404)
            return
        try:
            mlx_version = metadata.version("mlx-vlm")
        except metadata.PackageNotFoundError:
            mlx_version = "missing"
        body = json.dumps({
            "status": "ok",
            "modelLoaded": model is not None,
            "mlxVlmVersion": mlx_version,
            "frameWindows": mlx_video_supported(mlx_version),
        }).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path not in ("/observe", "/observe-video", "/observe-frames"):
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            limit = MAX_VIDEO_BYTES * 2 if self.path == "/observe-video" else MAX_FRAME_WINDOW_BYTES * 2 if self.path == "/observe-frames" else MAX_BYTES * 2
            if length <= 0 or length > limit: raise ValueError("request too large")
            payload = json.loads(self.rfile.read(length))
            out = observe_video(payload) if self.path == "/observe-video" else observe_frames(payload) if self.path == "/observe-frames" else observe(payload)
            body = json.dumps(out, ensure_ascii=False).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
        except Exception as exc:
            body = json.dumps({"status": "error", "message": str(exc)[:120]}).encode()
            self.send_response(400); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def log_message(self, *_): pass

if __name__ == "__main__":
    print("Mage-VL observer listening on http://127.0.0.1:7861", flush=True)
    ThreadingHTTPServer(("127.0.0.1", 7861), Handler).serve_forever()
