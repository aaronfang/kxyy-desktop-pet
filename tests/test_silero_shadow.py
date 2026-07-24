import json
import importlib.util
import math
import os
from pathlib import Path
import shutil
import sys
import tempfile
import types
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
LOCAL_REALTIME = ROOT / "scripts" / "local-realtime"
if str(LOCAL_REALTIME) not in sys.path:
    sys.path.insert(0, str(LOCAL_REALTIME))

import silero_shadow as silero

INSTALLER_SPEC = importlib.util.spec_from_file_location(
    "kxyy_vad_runtime_installer",
    LOCAL_REALTIME / "install_vad_runtime.py",
)
installer = importlib.util.module_from_spec(INSTALLER_SPEC)
INSTALLER_SPEC.loader.exec_module(installer)


def _mutate_manifest(root, field, value):
    path = root / silero.MANIFEST_FILENAME
    manifest = json.loads(path.read_text(encoding="utf-8"))
    if field in ("tag", "commit"):
        manifest["upstream"][field] = value
    elif field in ("frameSamples", "contextSamples", "signature"):
        manifest["model"][field] = value
    else:
        manifest[field] = value
    path.write_text(json.dumps(manifest), encoding="utf-8")


def _replace_model_with_symlink(root):
    model = root / silero.MODEL_FILENAME
    model.unlink()
    model.symlink_to(root / silero.LICENSE_FILENAME)


def _flip_model_byte(root):
    model = root / silero.MODEL_FILENAME
    with model.open("r+b") as handle:
        handle.seek(silero.MODEL_BYTES // 2)
        original = handle.read(1)
        handle.seek(-1, os.SEEK_CUR)
        handle.write(bytes((original[0] ^ 0x01,)))


class CapabilityTests(unittest.TestCase):
    def test_exact_official_wheel_allowlist(self):
        cases = (
            ({"system": "Windows", "machine": "AMD64", "python_version": (3, 10)}, "1.23.2", "none"),
            ({"system": "Windows", "machine": "x86_64", "python_version": (3, 14)}, "1.27.0", "none"),
            ({"system": "Darwin", "machine": "arm64", "python_version": (3, 13), "mac_version": "13.0"}, "1.23.2", "none"),
            ({"system": "Darwin", "machine": "arm64", "python_version": (3, 14), "mac_version": "14.0"}, "1.27.0", "none"),
            ({"system": "Darwin", "machine": "x86_64", "python_version": (3, 14), "mac_version": "14.0"}, None, "unsupported-python"),
            ({"system": "Darwin", "machine": "arm64", "python_version": (3, 14), "mac_version": "13.6"}, None, "unsupported-os"),
            ({"system": "Linux", "machine": "x86_64", "python_version": (3, 12)}, None, "unsupported-os"),
            ({"system": "Windows", "machine": "arm64", "python_version": (3, 12)}, None, "unsupported-arch"),
            ({"system": "Windows", "machine": "AMD64", "python_version": (3, 12), "pointer_bits": 32}, None, "unsupported-arch"),
            ({"system": "Windows", "machine": "x86_64", "python_version": (3, 9)}, None, "unsupported-python"),
            ({"system": "Windows", "machine": "x86_64", "python_version": (3, 12), "python_implementation": "PyPy"}, None, "unsupported-python"),
        )
        for inputs, expected_version, expected_reason in cases:
            with self.subTest(inputs=inputs):
                version, reason = silero.expected_ort_version(**inputs)
                self.assertEqual(version, expected_version)
                self.assertEqual(reason, expected_reason)

    def test_repository_model_and_license_match_strict_manifest(self):
        model = silero.validate_model_resources()
        self.assertEqual(model.name, silero.MODEL_FILENAME)
        self.assertEqual(model.stat().st_size, silero.MODEL_BYTES)

    def test_model_manifest_license_and_symlink_tampering_fail_closed(self):
        source = LOCAL_REALTIME / "models" / "silero-v6.2.1"
        mutations = [
            ("manifest-extra", lambda root: _mutate_manifest(root, "extra", True)),
            ("wrong-tag", lambda root: _mutate_manifest(root, "tag", "v0.0.0")),
            ("wrong-commit", lambda root: _mutate_manifest(root, "commit", "0" * 40)),
            ("wrong-frame", lambda root: _mutate_manifest(root, "frameSamples", 480)),
            ("wrong-context", lambda root: _mutate_manifest(root, "contextSamples", 32)),
            ("wrong-signature", lambda root: _mutate_manifest(root, "signature", "other")),
            ("model-byte-flip", _flip_model_byte),
            (
                "license-bytes",
                lambda root: (root / silero.LICENSE_FILENAME).write_bytes(b"tampered"),
            ),
        ]
        if os.name == "nt":
            mutations.append(
                ("model-missing", lambda root: (root / silero.MODEL_FILENAME).unlink())
            )
        else:
            mutations.append(("model-symlink", _replace_model_with_symlink))
        for name, mutate in mutations:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                root = Path(directory) / "model"
                shutil.copytree(source, root)
                mutate(root)
                with self.assertRaises(silero.SileroUnavailable) as raised:
                    silero.validate_model_resources(root)
                self.assertIn(
                    raised.exception.reason,
                    {"model-missing", "model-integrity-failed"},
                )

    def test_disabled_never_reads_model_or_runtime(self):
        capability = silero.probe_capability(
            enabled=False,
            runtime_root=Path("/forbidden/runtime"),
            model_dir=Path("/forbidden/model"),
        )
        self.assertEqual(capability.status, "disabled")
        self.assertEqual(capability.reason, "user-disabled")
        self.assertIsNone(capability.pipeline_factory())

    def test_ready_requires_exact_marker_but_does_not_import_runtime(self):
        platform_args = {
            "system": "Windows",
            "machine": "AMD64",
            "python_version": (3, 12),
        }
        with tempfile.TemporaryDirectory() as directory:
            runtime_root = Path(directory)
            target = silero.runtime_target(
                runtime_root,
                "1.23.2",
                fingerprint=silero.runtime_fingerprint(
                    system="windows",
                    machine="amd64",
                    cache_tag="cpython-312",
                    soabi="cp312-win_amd64",
                    pointer_bits=64,
                ),
            )
            target.mkdir(parents=True)
            (target / silero.RUNTIME_MARKER).write_text(
                "onnxruntime=1.23.2\n", encoding="utf-8"
            )
            with mock.patch.object(
                silero,
                "runtime_fingerprint",
                return_value=target.parent.name,
            ):
                capability = silero.probe_capability(
                    enabled=True,
                    runtime_root=runtime_root,
                    platform_args=platform_args,
                )
            self.assertTrue(capability.ready)
            self.assertEqual(capability.mode, "silero-onnx-shadow-v1")
            self.assertNotIn("onnxruntime", sys.modules)

            (target / silero.RUNTIME_MARKER).write_text(
                "onnxruntime=9.9.9\n", encoding="utf-8"
            )
            with mock.patch.object(
                silero,
                "runtime_fingerprint",
                return_value=target.parent.name,
            ):
                rejected = silero.probe_capability(
                    enabled=True,
                    runtime_root=runtime_root,
                    platform_args=platform_args,
                )
            self.assertEqual(rejected.status, "unavailable")
            self.assertEqual(rejected.reason, "runtime-version-mismatch")

    def test_runtime_lock_contains_only_fixed_wheel_names_and_hashes(self):
        lock = json.loads(
            (LOCAL_REALTIME / "vad-runtime-lock.json").read_text(encoding="utf-8")
        )
        self.assertEqual(lock["schemaVersion"], 1)
        self.assertEqual(lock["index"], "https://pypi.org/simple")
        self.assertEqual(
            set(lock["packages"]),
            {
                "coloredlogs==15.0.1",
                "flatbuffers==25.9.23",
                "humanfriendly==10.0",
                "onnxruntime==1.23.2",
                "onnxruntime==1.27.0",
            },
        )
        for wheels in lock["packages"].values():
            self.assertTrue(wheels)
            for filename, digest in wheels.items():
                self.assertRegex(filename, r"^[A-Za-z0-9_.-]+\.whl$")
                self.assertRegex(digest, r"^[0-9a-f]{64}$")

    def test_supported_abi_matrix_has_one_exact_ort_wheel(self):
        lock = installer._load_lock()
        cases = []
        for minor in range(10, 15):
            cases.append(("Windows", "AMD64", minor, None, "win_amd64"))
            if minor < 14:
                cases.extend(
                    (
                        ("Darwin", "arm64", minor, "13.0", "macosx_13_0_arm64"),
                        ("Darwin", "x86_64", minor, "13.0", "macosx_13_0_x86_64"),
                    )
                )
            else:
                cases.append(("Darwin", "arm64", minor, "14.0", "macosx_14_0_arm64"))

        for system, machine, minor, mac_version, suffix in cases:
            with self.subTest(system=system, machine=machine, minor=minor):
                version, reason = silero.expected_ort_version(
                    system=system,
                    machine=machine,
                    python_version=(3, minor),
                    mac_version=mac_version,
                )
                self.assertEqual(reason, "none")
                tag = f"cp3{minor}"
                expected = f"onnxruntime-{version}-{tag}-{tag}-{suffix}.whl"
                self.assertIn(expected, lock["packages"][f"onnxruntime=={version}"])

    def test_lock_and_wheel_set_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            invalid_lock = root / "invalid-lock.json"
            invalid_lock.write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "index": "https://pypi.org/simple",
                        "packages": {},
                        "unexpected": True,
                    }
                ),
                encoding="utf-8",
            )
            with mock.patch.object(installer, "LOCK_PATH", invalid_lock):
                with self.assertRaisesRegex(RuntimeError, "lock-invalid"):
                    installer._load_lock()

            downloads = root / "downloads"
            downloads.mkdir()
            wheel = downloads / "demo-1.0-py3-none-any.whl"
            wheel.write_bytes(b"fixed-wheel")
            digest = installer._hash_file(wheel)
            lock = {"packages": {"demo==1.0": {wheel.name: digest}}}
            self.assertEqual(
                installer._verify_wheels(downloads, ("demo==1.0",), lock),
                [wheel],
            )

            wheel.write_bytes(b"tampered-wheel")
            with self.assertRaisesRegex(RuntimeError, "wheel-integrity-failed"):
                installer._verify_wheels(downloads, ("demo==1.0",), lock)
            wheel.unlink()
            with self.assertRaisesRegex(RuntimeError, "wheel-set-invalid"):
                installer._verify_wheels(downloads, ("demo==1.0",), lock)
            (downloads / "unexpected.whl").write_bytes(b"unexpected")
            with self.assertRaisesRegex(RuntimeError, "wheel-set-invalid"):
                installer._verify_wheels(downloads, ("demo==1.0",), lock)

    def test_install_lock_rejects_concurrent_owner(self):
        with tempfile.TemporaryDirectory() as directory:
            lock_path = Path(directory) / ".install.lock"
            with installer._install_lock(lock_path):
                with self.assertRaisesRegex(RuntimeError, "install-busy"):
                    with installer._install_lock(lock_path):
                        self.fail("the second installer must not acquire the lock")

    def test_failed_reinstall_keeps_existing_target_and_cleans_staging(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime_root = Path(directory)
            fingerprint = "test-fingerprint"
            target = silero.runtime_target(
                runtime_root,
                "1.23.2",
                fingerprint=fingerprint,
            )
            target.mkdir(parents=True)
            marker = target / silero.RUNTIME_MARKER
            marker.write_text("onnxruntime=1.23.2\n", encoding="utf-8")

            with (
                mock.patch.object(
                    installer.silero_shadow,
                    "expected_ort_version",
                    return_value=("1.23.2", "none"),
                ),
                mock.patch.object(
                    installer.silero_shadow,
                    "runtime_fingerprint",
                    return_value=fingerprint,
                ),
                mock.patch.object(
                    installer,
                    "_verify_target",
                    side_effect=RuntimeError("verification-failed"),
                ),
                mock.patch.object(
                    installer,
                    "_run_fixed",
                    side_effect=RuntimeError("subprocess-failed"),
                ),
            ):
                with self.assertRaisesRegex(RuntimeError, "subprocess-failed"):
                    installer.install(runtime_root)

            self.assertEqual(
                marker.read_text(encoding="utf-8"),
                "onnxruntime=1.23.2\n",
            )
            self.assertEqual(list(target.parent.glob(".vad-staging-*")), [])

    def test_publish_rollback_and_crash_recovery_keep_ready_target(self):
        with tempfile.TemporaryDirectory() as directory:
            parent = Path(directory)
            target = parent / "runtime"
            payload = parent / "payload"
            target.mkdir()
            payload.mkdir()
            (target / "old").write_text("ready", encoding="utf-8")
            (payload / "new").write_text("ready", encoding="utf-8")

            real_replace = os.replace

            def fail_new_publish(source, destination):
                if Path(source) == payload and Path(destination) == target:
                    raise OSError("synthetic replace failure")
                real_replace(source, destination)

            with mock.patch.object(installer.os, "replace", side_effect=fail_new_publish):
                with self.assertRaisesRegex(OSError, "synthetic replace failure"):
                    installer._publish_payload(payload, target)
            self.assertEqual((target / "old").read_text(encoding="utf-8"), "ready")

            backup = installer._backup_target(target)
            os.replace(target, backup)
            self.assertFalse(target.exists())
            installer._recover_publish(target)
            self.assertEqual((target / "old").read_text(encoding="utf-8"), "ready")


class FakeMeta:
    def __init__(self, name, type_name, shape):
        self.name = name
        self.type = type_name
        self.shape = shape


class FakeSession:
    def __init__(self, np):
        self.np = np
        self.calls = []
        self.malformed = False

    def get_inputs(self):
        return [
            FakeMeta("input", "tensor(float)", ["batch", "sequence"]),
            FakeMeta("state", "tensor(float)", [2, "batch", 128]),
            FakeMeta("sr", "tensor(int64)", []),
        ]

    def get_outputs(self):
        return [
            FakeMeta("output", "tensor(float)", ["batch", 1]),
            FakeMeta("stateN", "tensor(float)", ["state", "batch", "width"]),
        ]

    def run(self, names, values):
        self.calls.append((names, {key: value.copy() for key, value in values.items()}))
        if self.malformed:
            return (
                self.np.asarray([[math.nan]], dtype=self.np.float32),
                self.np.zeros(silero.STATE_SHAPE, dtype=self.np.float32),
            )
        return (
            self.np.asarray([[0.75]], dtype=self.np.float32),
            values["state"] + self.np.float32(1.0),
        )


class ScorerContractTests(unittest.TestCase):
    def setUp(self):
        try:
            import numpy as np
        except ImportError:
            self.fail(
                "NumPy is required for deterministic fake-ORT scorer tests; "
                "CI must install the pinned test dependency"
            )
        self.np = np
        self.session = FakeSession(np)

        class FakeOptions:
            inter_op_num_threads = 0
            intra_op_num_threads = 0

        self.fake_ort = types.SimpleNamespace(
            __version__="1.23.2",
            get_available_providers=lambda: ["CPUExecutionProvider"],
            SessionOptions=FakeOptions,
            InferenceSession=lambda *_args, **_kwargs: self.session,
        )

    def make_scorer(self):
        with tempfile.TemporaryDirectory() as directory:
            model = Path(directory) / silero.MODEL_FILENAME
            with (
                mock.patch.object(silero, "validate_model_resources", return_value=model),
                mock.patch.object(silero, "_load_onnxruntime", return_value=self.fake_ort),
            ):
                return silero.SileroOnnxScorer(
                    model,
                    runtime_path=Path(directory),
                    expected_ort_version="1.23.2",
                )

    def test_pcm_context_recurrent_state_and_reset_contract(self):
        scorer = self.make_scorer()
        frame = (
            int(-32768).to_bytes(2, "little", signed=True)
            + int(0).to_bytes(2, "little", signed=True)
            + int(32767).to_bytes(2, "little", signed=True)
            + bytes((silero.FRAME_SAMPLES - 3) * 2)
        )
        self.assertEqual(scorer(frame), 0.75)
        first = self.session.calls[-1][1]
        self.assertEqual(first["input"].shape, (1, 576))
        self.assertTrue((first["input"][0, :64] == 0).all())
        self.assertEqual(float(first["input"][0, 64]), -1.0)
        self.assertEqual(float(first["input"][0, 65]), 0.0)
        self.assertAlmostEqual(float(first["input"][0, 66]), 32767 / 32768)
        self.assertTrue((first["state"] == 0).all())

        scorer(bytes(silero.FRAME_SAMPLES * 2))
        second = self.session.calls[-1][1]
        self.assertTrue((second["state"] == 1).all())
        scorer.reset()
        scorer(bytes(silero.FRAME_SAMPLES * 2))
        reset = self.session.calls[-1][1]
        self.assertTrue((reset["state"] == 0).all())
        scorer.close()

    def test_malformed_native_output_fails_with_fixed_reason(self):
        scorer = self.make_scorer()
        self.session.malformed = True
        with self.assertRaises(silero.SileroUnavailable) as raised:
            scorer(bytes(silero.FRAME_SAMPLES * 2))
        self.assertEqual(raised.exception.reason, "model-contract-mismatch")
        self.assertNotIn("path", str(raised.exception))


@unittest.skipUnless(
    os.environ.get("KXYY_RUN_SILERO_SMOKE") == "1",
    "set KXYY_RUN_SILERO_SMOKE=1 with KXYY_VAD_RUNTIME_ROOT",
)
class RealRuntimeSmokeTests(unittest.TestCase):
    def test_real_model_returns_finite_probability_and_reset_is_reproducible(self):
        capability = silero.probe_capability(
            enabled=True,
            runtime_root=os.environ.get("KXYY_VAD_RUNTIME_ROOT"),
        )
        self.assertTrue(capability.ready, capability.reason)
        pipeline = capability.pipeline_factory()()
        pipeline.reset(1)
        first = pipeline.feed(bytes(silero.FRAME_SAMPLES * 2), generation=1)[0]
        pipeline.reset(2)
        second = pipeline.feed(bytes(silero.FRAME_SAMPLES * 2), generation=2)[0]
        self.assertTrue(math.isfinite(first.probability))
        self.assertAlmostEqual(first.probability, second.probability, places=7)
        pipeline.close()


if __name__ == "__main__":
    unittest.main()
