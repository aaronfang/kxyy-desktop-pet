import importlib.util
from pathlib import Path
import unittest


MODULE_PATH = Path(__file__).parents[1] / "scripts" / "mage-vl" / "watch_window.py"
SPEC = importlib.util.spec_from_file_location("watch_window", MODULE_PATH)
watch_window = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(watch_window)


class WatchWindowTests(unittest.TestCase):
    def test_window_recording_command_targets_selected_window_is_bounded_and_silent(self):
        command = watch_window.capture_command(Path("/tmp/clip.mov"), seconds=12, window_id=42)
        self.assertEqual(command[0], "/usr/sbin/screencapture")
        self.assertIn("-v", command)
        self.assertIn("-V12", command)
        self.assertIn("-x", command)
        self.assertIn("-l42", command)
        self.assertEqual(command[-1], "/tmp/clip.mov")

    def test_window_recording_duration_is_hard_bounded(self):
        self.assertEqual(watch_window.normalize_seconds(0), 3)
        self.assertEqual(watch_window.normalize_seconds(99), 15)
        self.assertEqual(watch_window.normalize_seconds(8), 8)

    def test_observation_interval_is_at_least_three_seconds(self):
        self.assertEqual(watch_window.normalize_interval(1), 3)
        self.assertEqual(watch_window.normalize_interval(3), 3)

    def test_continuous_prompt_requests_a_bounded_one_sentence_summary(self):
        self.assertIn("一句话", watch_window.CONTINUOUS_QUESTION)
        self.assertLessEqual(watch_window.CONTINUOUS_MAX_TOKENS, 96)
        self.assertEqual(watch_window.CONTINUOUS_MAX_SIDE, 640)

    def test_observation_loop_reuses_the_selected_window_without_overlap(self):
        captured = []
        observed = []
        slept = []
        now = [0.0]

        def capture(window_id, output):
            captured.append((window_id, output))

        def observe(output):
            observed.append(output)
            return {"summary": "ok"}

        def sleep(seconds):
            slept.append(seconds)
            now[0] += seconds

        records = watch_window.run_observation_loop(
            42, rounds=3, interval=3, capture_frame=capture,
            observe_frame=observe, sleep_fn=sleep, clock_fn=lambda: now[0],
        )
        self.assertEqual([item[0] for item in captured], [42, 42, 42])
        self.assertEqual(len(observed), 3)
        self.assertEqual(len(records), 3)
        self.assertEqual(slept, [3, 3])

    def test_monitor_lines_keep_round_latency_and_full_summary(self):
        line = watch_window.format_monitor_line({"round": 4, "latencyMs": 1180, "result": {"summary": "画面中有人正在讲话。"}})
        self.assertIn("第 4 轮", line)
        self.assertIn("1.18s", line)
        self.assertIn("画面中有人正在讲话。", line)
