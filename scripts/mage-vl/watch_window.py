#!/usr/bin/env python3
"""Record one user-selected macOS window and ask the local Mage-VL observer about it."""
import argparse
import base64
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

MIN_SECONDS = 3
MAX_SECONDS = 15
MAX_VIDEO_BYTES = 96 * 1024 * 1024
MIN_INTERVAL_SECONDS = 3
MAX_INTERVAL_SECONDS = 60
CONTINUOUS_MAX_TOKENS = 64
CONTINUOUS_MAX_SIDE = 640
CONTINUOUS_QUESTION = "请只用一句话（最多60字）描述当前画面中最重要、明确可见的内容；不要列清单，不要复述界面按钮，不确定就少说。"
WINDOW_LISTER = Path(__file__).with_name("list_windows.swift")


def format_monitor_line(record):
    latency = record.get("latencyMs", 0) / 1000
    summary = str(record.get("result", {}).get("summary", "")).strip()
    return f"第 {record.get('round', '?')} 轮 · {latency:.2f}s\n{summary}\n\n"


def normalize_seconds(value):
    try:
        return max(MIN_SECONDS, min(MAX_SECONDS, int(value)))
    except (TypeError, ValueError):
        return MIN_SECONDS


def normalize_interval(value):
    try:
        return max(MIN_INTERVAL_SECONDS, min(MAX_INTERVAL_SECONDS, int(value)))
    except (TypeError, ValueError):
        return MIN_INTERVAL_SECONDS


def capture_command(output, seconds, window_id):
    return ["/usr/sbin/screencapture", "-l" + str(int(window_id)), "-v", f"-V{normalize_seconds(seconds)}", "-x", str(output)]


def capture_frame_command(output, window_id):
    return ["/usr/sbin/screencapture", "-l" + str(int(window_id)), "-x", "-t", "jpg", str(output)]


def visible_windows():
    result = subprocess.run(["swift", str(WINDOW_LISTER)], capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise RuntimeError("无法读取 macOS 窗口列表")
    windows = json.loads(result.stdout)
    return [window for window in windows if isinstance(window.get("id"), int) and window.get("owner")]


def choose_window():
    windows = visible_windows()
    if not windows:
        raise RuntimeError("没有可录制的可见窗口")
    for index, window in enumerate(windows, 1):
        label = " · ".join(part for part in [window["owner"], window.get("title", "").strip()] if part)
        print(f"{index}. {label[:120]}")
    try:
        selected = int(input("选择窗口编号："))
        return windows[selected - 1]["id"]
    except (ValueError, EOFError, IndexError):
        raise RuntimeError("未选择有效窗口")


def post_video(video_path, endpoint):
    raw = video_path.read_bytes()
    if not raw or len(raw) > MAX_VIDEO_BYTES:
        raise RuntimeError("录制失败，或视频超过 96 MB 上限")
    body = json.dumps({
        "videoBase64": base64.b64encode(raw).decode("ascii"),
        "question": "以下是按时间顺序抽取的短视频画面。请简要讲述你明确看到的内容变化；不确定处直接说明。",
    }).encode("utf-8")
    request = urllib.request.Request(
        endpoint.rstrip("/") + "/observe-video", data=body,
        headers={"Content-Type": "application/json"}, method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            payload = json.loads(response.read())
    except urllib.error.URLError as error:
        raise RuntimeError(f"视觉服务不可用：{error.reason}") from error
    if payload.get("status") != "ok" or not payload.get("summary"):
        raise RuntimeError("视觉服务没有返回有效摘要")
    return payload["summary"]


def post_image(image_path, endpoint):
    from PIL import Image
    with Image.open(image_path) as image:
        image = image.convert("RGB")
        image.thumbnail((CONTINUOUS_MAX_SIDE, CONTINUOUS_MAX_SIDE))
        buffer = __import__("io").BytesIO()
        image.save(buffer, format="JPEG", quality=82, optimize=True)
        raw = buffer.getvalue()
    body = json.dumps({
        "imageDataUrl": "data:image/jpeg;base64," + base64.b64encode(raw).decode("ascii"),
        "question": CONTINUOUS_QUESTION,
    }).encode("utf-8")
    request = urllib.request.Request(
        endpoint.rstrip("/") + "/observe", data=body,
        headers={"Content-Type": "application/json"}, method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            payload = json.loads(response.read())
    except urllib.error.URLError as error:
        raise RuntimeError(f"视觉服务不可用：{error.reason}") from error
    if payload.get("status") != "ok" or not payload.get("summary"):
        raise RuntimeError("视觉服务没有返回有效摘要")
    return payload


def run_observation_loop(window_id, *, rounds, interval, capture_frame, observe_frame,
                         sleep_fn=time.sleep, clock_fn=time.monotonic):
    """Run bounded, serial observations against one already-selected window."""
    total = max(1, min(60, int(rounds)))
    cadence = normalize_interval(interval)
    records = []
    next_due = clock_fn()
    for index in range(total):
        if index:
            delay = max(0, next_due - clock_fn())
            if delay:
                sleep_fn(delay)
        started = clock_fn()
        output = f"frame-{index}"
        capture_frame(window_id, output)
        result = observe_frame(output)
        finished = clock_fn()
        records.append({"round": index + 1, "latencyMs": max(0, round((finished - started) * 1000)), "result": result})
        next_due += cadence
    return records


def run_live_observation(window_id, *, rounds, interval, endpoint):
    with tempfile.TemporaryDirectory(prefix="kxyy-mage-observe-") as directory:
        root = Path(directory)

        def capture(window, output):
            path = root / f"{output}.jpg"
            result = subprocess.run(capture_frame_command(path, window), check=False, capture_output=True, text=True)
            if result.returncode != 0 or not path.exists():
                raise RuntimeError("抓取指定窗口失败，请检查窗口是否仍可见及屏幕录制权限")
            return path

        def observe(output):
            return post_image(root / f"{output}.jpg", endpoint)

        def capture_and_remember(window, output):
            capture(window, output)

        records = run_observation_loop(window_id, rounds=rounds, interval=interval,
                                       capture_frame=capture_and_remember, observe_frame=observe)
        return records


def main():
    parser = argparse.ArgumentParser(description="录制一个用户选择的 macOS 窗口并由 Mage-VL 总结")
    parser.add_argument("--seconds", default=10, type=int, help="录制秒数（3--15，默认 10）")
    parser.add_argument("--endpoint", default="http://127.0.0.1:7861")
    parser.add_argument("--window-id", type=int, help="跳过窗口列表，直接使用指定 macOS window id")
    parser.add_argument("--interval", default=3, type=int, help="连续观察间隔秒数，最小 3 秒")
    parser.add_argument("--rounds", default=1, type=int, help="连续观察轮数，默认 1；每轮使用同一个窗口")
    parser.add_argument("--continuous", action="store_true", help="按固定间隔连续观察所选窗口")
    args = parser.parse_args()
    seconds = normalize_seconds(args.seconds)
    window_id = args.window_id if args.window_id is not None else choose_window()
    if args.continuous or args.rounds > 1:
        records = run_live_observation(window_id, rounds=args.rounds, interval=args.interval, endpoint=args.endpoint)
        for record in records:
            print(json.dumps({"round": record["round"], "latencyMs": record["latencyMs"], "summary": record["result"]["summary"]}, ensure_ascii=False), flush=True)
        return
    with tempfile.TemporaryDirectory(prefix="kxyy-mage-window-") as directory:
        video_path = Path(directory) / "window.mov"
        print(f"正在录制所选窗口，最多 {seconds} 秒。", flush=True)
        result = subprocess.run(capture_command(video_path, seconds, window_id), check=False)
        if result.returncode != 0 or not video_path.exists():
            raise RuntimeError("窗口录制已取消或系统拒绝了屏幕录制权限")
        print("正在本地分析视频…", flush=True)
        print(post_video(video_path, args.endpoint), flush=True)


if __name__ == "__main__":
    try:
        main()
    except RuntimeError as error:
        print(f"失败：{error}", file=sys.stderr)
        sys.exit(1)
