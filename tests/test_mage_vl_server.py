import base64
import importlib.util
import io
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

try:
    from PIL import Image
except ModuleNotFoundError:  # Mage-VL's optional image dependency is not in every CI runner.
    Image = None


MODULE_PATH = Path(__file__).parents[1] / "scripts" / "mage-vl" / "server.py"
SPEC = importlib.util.spec_from_file_location("kxyy_mage_vl_server", MODULE_PATH)
SERVER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SERVER)


def image_data_url(color):
    output = io.BytesIO()
    Image.new("RGB", (8, 6), color).save(output, format="JPEG")
    return "data:image/jpeg;base64," + base64.b64encode(output.getvalue()).decode()


@unittest.skipUnless(Image is not None, "Pillow is required for Mage-VL server tests")
class MageVlFrameWindowTests(unittest.TestCase):
    def test_observe_frames_sends_one_time_aware_video_to_mage(self):
        calls = []

        def generate(images, question, max_tokens, **kwargs):
            calls.append((images, question, max_tokens, kwargs))
            return "人物从门边走到桌前。"

        result = SERVER.observe_frames(
            {
                "frames": [
                    {"capturedAtMs": 1000, "imageDataUrl": image_data_url("red")},
                    {"capturedAtMs": 1500, "imageDataUrl": image_data_url("green")},
                    {"capturedAtMs": 3000, "imageDataUrl": image_data_url("blue")},
                ],
                "question": "描述变化",
            },
            generate_fn=generate,
        )

        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["source"], "frame-window")
        self.assertEqual(result["expiresAtMs"], 123000)
        self.assertEqual(result["frameCount"], 3)
        self.assertEqual(len(calls), 1)
        images, question, max_tokens, kwargs = calls[0]
        self.assertEqual(len(images), 3)
        self.assertEqual(max_tokens, 160)
        self.assertIn("0.0秒、0.5秒、2.0秒", question)
        self.assertEqual(kwargs["video_metadata"], [{
            "total_num_frames": 5,
            "fps": 2.0,
            "frames_indices": [0, 1, 4],
        }])

    def test_observe_frames_rejects_unbounded_or_non_monotonic_windows(self):
        valid = {"capturedAtMs": 1000, "imageDataUrl": image_data_url("white")}
        with self.assertRaisesRegex(ValueError, "2 to 4"):
            SERVER.observe_frames({"frames": [valid]}, generate_fn=lambda *_args, **_kwargs: "")
        with self.assertRaisesRegex(ValueError, "2 to 4"):
            SERVER.observe_frames({"frames": [valid] * 5}, generate_fn=lambda *_args, **_kwargs: "")
        with self.assertRaisesRegex(ValueError, "strictly increasing"):
            SERVER.observe_frames({"frames": [
                valid,
                {"capturedAtMs": 900, "imageDataUrl": image_data_url("black")},
            ]}, generate_fn=lambda *_args, **_kwargs: "")
        with self.assertRaisesRegex(ValueError, "invalid image"):
            SERVER.observe_frames({"frames": [
                valid,
                {"capturedAtMs": 1500, "imageDataUrl": "data:image/jpeg;base64,not-base64"},
            ]}, generate_fn=lambda *_args, **_kwargs: "")

    def test_video_runtime_version_is_allowlisted(self):
        self.assertFalse(SERVER.mlx_video_supported("0.7.0rc0"))
        self.assertTrue(SERVER.mlx_video_supported("0.7.1"))
        self.assertTrue(SERVER.mlx_video_supported("0.7.4"))
        self.assertFalse(SERVER.mlx_video_supported("unknown"))

    def test_generate_summary_uses_the_mlx_video_processor_contract(self):
        images = [Image.new("RGB", (8, 6), "red"), Image.new("RGB", (8, 6), "blue")]
        metadata_value = [{"total_num_frames": 2, "fps": 2.0, "frames_indices": [0, 1]}]
        calls = {}

        def apply_template(processor, config, question, **kwargs):
            calls["template"] = (processor, config, question, kwargs)
            return "video-prompt"

        def generate(model, processor, prompt, **kwargs):
            calls["generate"] = (model, processor, prompt, kwargs)
            return SimpleNamespace(text="窗口变化")

        previous_model, previous_processor = SERVER.model, SERVER.processor
        SERVER.model, SERVER.processor = SimpleNamespace(config={"model_type": "mage_vl"}), object()
        try:
            with patch("mlx_vlm.generate", generate), patch(
                "mlx_vlm.prompt_utils.apply_chat_template", apply_template
            ):
                result = SERVER.generate_summary(
                    images,
                    "描述变化",
                    160,
                    video_metadata=metadata_value,
                )
        finally:
            SERVER.model, SERVER.processor = previous_model, previous_processor

        self.assertEqual(result, "窗口变化")
        self.assertEqual(calls["template"][3]["video"], [images])
        self.assertEqual(calls["generate"][3]["video"], [images])
        self.assertEqual(calls["generate"][3]["video_metadata"], metadata_value)
        self.assertEqual(calls["generate"][3]["fps"], [2.0])


if __name__ == "__main__":
    unittest.main()
