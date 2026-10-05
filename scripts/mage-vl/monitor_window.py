#!/usr/bin/env python3
"""Small local GUI for watching sustained Mage-VL window observations."""
import argparse
import queue
import threading
import time
import tkinter as tk
from tkinter import messagebox, ttk

from watch_window import choose_window, capture_frame_command, format_monitor_line, normalize_interval, post_image, visible_windows
import subprocess
import tempfile
from pathlib import Path


class MonitorApp:
    def __init__(self, root, *, endpoint, interval, rounds):
        self.root = root
        self.endpoint = endpoint
        self.interval = normalize_interval(interval)
        self.rounds = max(0, int(rounds))
        self.window_id = None
        self.window_label = "未选择"
        self.events = queue.Queue()
        self.stop_event = threading.Event()
        self.worker = None
        self.root.title("Mage-VL 连续观察监控")
        self.root.geometry("760x560")
        self.status = tk.StringVar(value="请选择窗口后开始")
        self.window_var = tk.StringVar(value="未选择")
        self._build()
        self.root.protocol("WM_DELETE_WINDOW", self.close)
        self.root.after(100, self._drain_events)

    def _build(self):
        toolbar = ttk.Frame(self.root, padding=10)
        toolbar.pack(fill="x")
        ttk.Label(toolbar, text="固定窗口：").pack(side="left")
        ttk.Label(toolbar, textvariable=self.window_var, width=34).pack(side="left", padx=(0, 10))
        ttk.Button(toolbar, text="选择窗口", command=self.select_window).pack(side="left")
        ttk.Button(toolbar, text="开始", command=self.start).pack(side="left", padx=6)
        ttk.Button(toolbar, text="停止", command=self.stop).pack(side="left")
        ttk.Label(self.root, textvariable=self.status, padding=(10, 0)).pack(anchor="w")
        self.output = tk.Text(self.root, wrap="word", state="disabled", font=("Menlo", 13))
        self.output.pack(fill="both", expand=True, padx=10, pady=10)

    def select_window(self):
        try:
            windows = visible_windows()
            if not windows:
                raise RuntimeError("没有可见窗口")
            labels = [" · ".join(part for part in [w["owner"], w.get("title", "").strip()] if part) for w in windows]
            choice = self._choose_from_dialog(labels)
            if choice is None:
                return
            self.window_id = windows[choice]["id"]
            self.window_label = labels[choice][:80]
            self.window_var.set(f"{self.window_label} (id={self.window_id})")
            self.status.set("窗口已固定；开始后不会重新选择")
        except Exception as error:
            messagebox.showerror("选择窗口失败", str(error))

    def _choose_from_dialog(self, labels):
        dialog = tk.Toplevel(self.root)
        dialog.title("选择观察窗口")
        dialog.transient(self.root)
        choice = {"value": None}
        listbox = tk.Listbox(dialog, width=72, height=min(12, len(labels)))
        for label in labels:
            listbox.insert(tk.END, label)
        listbox.pack(padx=12, pady=12)
        def confirm():
            selected = listbox.curselection()
            if selected:
                choice["value"] = selected[0]
            dialog.destroy()
        ttk.Button(dialog, text="确定", command=confirm).pack(pady=(0, 12))
        dialog.grab_set()
        self.root.wait_window(dialog)
        return choice["value"]

    def append(self, text):
        self.output.configure(state="normal")
        self.output.insert(tk.END, text)
        self.output.see(tk.END)
        self.output.configure(state="disabled")

    def start(self):
        if self.worker and self.worker.is_alive():
            return
        if self.window_id is None:
            self.select_window()
        if self.window_id is None:
            return
        self.stop_event.clear()
        self.append(f"开始观察：{self.window_label}，目标间隔 {self.interval}s\n\n")
        self.status.set("运行中 · 固定窗口 ID，不会切换目标")
        self.worker = threading.Thread(target=self._run, daemon=True)
        self.worker.start()

    def stop(self):
        self.stop_event.set()
        self.status.set("正在停止；等待当前推理返回")

    def _run(self):
        with tempfile.TemporaryDirectory(prefix="kxyy-mage-monitor-") as directory:
            root = Path(directory)
            next_due = time.monotonic()
            round_index = 0
            while not self.stop_event.is_set() and (self.rounds <= 0 or round_index < self.rounds):
                if round_index and (delay := next_due - time.monotonic()) > 0:
                    self.stop_event.wait(delay)
                    if self.stop_event.is_set():
                        break
                started = time.monotonic()
                path = root / f"frame-{round_index}.jpg"
                try:
                    result = subprocess.run(capture_frame_command(path, self.window_id), check=False, capture_output=True, text=True)
                    if result.returncode != 0 or not path.exists():
                        raise RuntimeError("指定窗口不可用，或屏幕录制权限被拒绝")
                    payload = post_image(path, self.endpoint)
                    self.events.put(("result", {"round": round_index + 1, "latencyMs": round((time.monotonic() - started) * 1000), "result": payload}))
                except Exception as error:
                    self.events.put(("error", str(error)))
                    break
                round_index += 1
                next_due += self.interval
            self.events.put(("stopped", None))

    def _drain_events(self):
        try:
            while True:
                kind, value = self.events.get_nowait()
                if kind == "result":
                    self.append(format_monitor_line(value))
                elif kind == "error":
                    self.append(f"错误：{value}\n\n")
                    self.status.set("已停止 · 请检查窗口和服务")
                else:
                    self.status.set("已停止")
        except queue.Empty:
            pass
        self.root.after(100, self._drain_events)

    def close(self):
        self.stop_event.set()
        self.root.destroy()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--endpoint", default="http://127.0.0.1:7861")
    parser.add_argument("--interval", default=3, type=int)
    parser.add_argument("--rounds", default=0, type=int, help="0 表示持续运行直到点击停止")
    args = parser.parse_args()
    root = tk.Tk()
    MonitorApp(root, endpoint=args.endpoint, interval=args.interval, rounds=args.rounds)
    root.mainloop()


if __name__ == "__main__":
    main()
