#!/usr/bin/env python3
import base64, json, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
from pathlib import Path
import tempfile

import cv2

MODEL_ID = "mlx-community/Mage-VL-8bit"
MAX_BYTES = 8 * 1024 * 1024
MAX_VIDEO_BYTES = 96 * 1024 * 1024
MAX_VIDEO_FRAMES = 4
VIDEO_MAX_SIDE = 640
IMAGE_MAX_TOKENS = 64
IMAGE_MAX_SIDE = 640
VIDEO_MAX_TOKENS = 160
IMAGE_QUESTION = "请只描述明确可见的画面内容。不要猜测作品名或角色名；除非画面文字清楚显示名字，否则人物只用外观或身份代称。不确定就少说。"
model = processor = None

def generate_summary(images, question, max_tokens):
    global model, processor
    from mlx_vlm import load, generate
    from mlx_vlm.prompt_utils import apply_chat_template
    if model is None:
        model, processor = load(MODEL_ID)
    prompt = apply_chat_template(processor, model.config, question, num_images=len(images))
    return generate(model, processor, prompt, image=images, max_tokens=max_tokens).text

def response(summary, source):
    now = int(time.time() * 1000)
    return {"status": "ok", "summary": str(summary).strip()[:900], "source": source, "capturedAtMs": now, "expiresAtMs": now + 120000}

def observe(data):
    from PIL import Image
    raw = str(data.get("imageDataUrl", ""))
    if not raw.startswith("data:image/") or "," not in raw:
        raise ValueError("invalid image")
    blob = base64.b64decode(raw.split(",", 1)[1], validate=True)
    if len(blob) > MAX_BYTES: raise ValueError("image too large")
    image = Image.open(BytesIO(blob)).convert("RGB")
    image.thumbnail((IMAGE_MAX_SIDE, IMAGE_MAX_SIDE))
    question = str(data.get("question") or IMAGE_QUESTION)[:240]
    return response(generate_summary([image], question, IMAGE_MAX_TOKENS), "image")

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
        body = json.dumps({"status": "ok", "modelLoaded": model is not None}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path not in ("/observe", "/observe-video"):
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            limit = MAX_VIDEO_BYTES * 2 if self.path == "/observe-video" else MAX_BYTES * 2
            if length <= 0 or length > limit: raise ValueError("request too large")
            payload = json.loads(self.rfile.read(length))
            out = observe_video(payload) if self.path == "/observe-video" else observe(payload)
            body = json.dumps(out, ensure_ascii=False).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
        except Exception as exc:
            body = json.dumps({"status": "error", "message": str(exc)[:120]}).encode()
            self.send_response(400); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def log_message(self, *_): pass

if __name__ == "__main__":
    print("Mage-VL observer listening on http://127.0.0.1:7861", flush=True)
    ThreadingHTTPServer(("127.0.0.1", 7861), Handler).serve_forever()
