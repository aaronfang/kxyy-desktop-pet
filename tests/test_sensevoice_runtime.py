import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
LOCAL_REALTIME = ROOT / "scripts" / "local-realtime"
INSTALLER_SPEC = importlib.util.spec_from_file_location(
    "kxyy_sensevoice_runtime_installer",
    LOCAL_REALTIME / "install_sensevoice_runtime.py",
)
installer = importlib.util.module_from_spec(INSTALLER_SPEC)
INSTALLER_SPEC.loader.exec_module(installer)


class FakeResponse:
    def __init__(self, url, payload):
        self.url = url
        self.payload = io.BytesIO(payload)

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def geturl(self):
        return self.url

    def read(self, size=-1):
        return self.payload.read(size)


class SenseVoiceRuntimeInstallerTests(unittest.TestCase):
    def test_exact_supported_platform_matrix(self):
        for minor in range(10, 15):
            cases = (
                ("Darwin", "arm64", f"cp3{minor}-macos-arm64", "macos-arm64"),
                ("Darwin", "x86_64", f"cp3{minor}-macos-x64", "macos-x64"),
                ("Windows", "AMD64", f"cp3{minor}-windows-x64", "windows-x64"),
            )
            for system, machine, wrapper, core in cases:
                with self.subTest(minor=minor, system=system, machine=machine):
                    self.assertEqual(
                        installer.platform_identity(
                            system=system,
                            machine=machine,
                            python_version=(3, minor),
                            implementation="cpython",
                            pointer_bits=64,
                        ),
                        (wrapper, core),
                    )

        invalid = (
            ({"system": "Linux", "machine": "x86_64"}, "unsupported-os"),
            ({"system": "Windows", "machine": "arm64"}, "unsupported-arch"),
            ({"system": "Darwin", "machine": "ppc64"}, "unsupported-arch"),
            ({"python_version": (3, 9)}, "unsupported-python"),
            ({"python_version": (3, 15)}, "unsupported-python"),
            ({"implementation": "pypy"}, "unsupported-python"),
            ({"pointer_bits": 32}, "unsupported-python"),
        )
        defaults = {
            "system": "Darwin",
            "machine": "arm64",
            "python_version": (3, 12),
            "implementation": "cpython",
            "pointer_bits": 64,
        }
        for overrides, reason in invalid:
            with self.subTest(overrides=overrides):
                with self.assertRaisesRegex(RuntimeError, reason):
                    installer.platform_identity(**{**defaults, **overrides})

    def test_lock_is_complete_fixed_and_https_only(self):
        lock = installer._load_lock()
        self.assertEqual(lock["runtimeVersion"], "1.13.4")
        wrappers = lock["artifacts"]["sherpa-onnx"]
        cores = lock["artifacts"]["sherpa-onnx-core"]
        self.assertEqual(len(wrappers), 15)
        self.assertEqual(len(cores), 3)
        for artifact in (*wrappers.values(), *cores.values()):
            filename, url, size, digest = artifact
            self.assertTrue(filename.endswith(".whl"))
            self.assertTrue(url.startswith("https://files.pythonhosted.org/"))
            self.assertGreater(size, 1_000_000)
            self.assertRegex(digest, r"^[0-9a-f]{64}$")
        archive = lock["model"]["archive"]
        self.assertEqual(archive[2], 163002883)
        self.assertEqual(
            archive[3],
            "7d1efa2138a65b0b488df37f8b89e3d91a60676e416f515b952358d83dfd347e",
        )
        self.assertEqual(
            lock["model"]["files"]["model.int8.onnx"],
            [
                239233841,
                "c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51",
            ],
        )
        notice = (LOCAL_REALTIME / "SENSEVOICE-NOTICE.md").read_text(encoding="utf-8")
        self.assertIn("FunASR Model Open Source License Agreement 1.1", notice)
        self.assertIn("sherpa-onnx", notice)

    def test_invalid_lock_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "lock.json"
            path.write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "runtimeVersion": "1.13.4",
                        "artifacts": {},
                        "model": {},
                        "unexpected": True,
                    }
                ),
                encoding="utf-8",
            )
            with mock.patch.object(installer, "LOCK_PATH", path):
                with self.assertRaisesRegex(RuntimeError, "lock-invalid"):
                    installer._load_lock()

    def test_download_requires_exact_size_hash_and_https_redirect(self):
        payload = b"fixed artifact"
        digest = hashlib.sha256(payload).hexdigest()
        artifact = [
            "fixed.whl",
            "https://files.pythonhosted.org/fixed.whl",
            len(payload),
            digest,
        ]
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "fixed.whl"
            with mock.patch.object(
                installer.urllib.request,
                "urlopen",
                return_value=FakeResponse(artifact[1], payload),
            ):
                self.assertEqual(
                    installer._download_artifact(artifact, destination), destination
                )
            self.assertEqual(destination.read_bytes(), payload)

            destination.unlink()
            with mock.patch.object(
                installer.urllib.request,
                "urlopen",
                return_value=FakeResponse(artifact[1], payload + b"x"),
            ):
                with self.assertRaisesRegex(RuntimeError, "download-integrity-failed"):
                    installer._download_artifact(artifact, destination)
            self.assertFalse(destination.exists())

            with mock.patch.object(
                installer.urllib.request,
                "urlopen",
                return_value=FakeResponse("http://downgrade.invalid/fixed.whl", payload),
            ):
                with self.assertRaisesRegex(RuntimeError, "download-invalid"):
                    installer._download_artifact(artifact, destination)

    def test_archive_materialization_keeps_only_locked_files_and_smoke(self):
        files = {
            "model.int8.onnx": b"model",
            "tokens.txt": b"tokens",
            "LICENSE": b"license",
            "README.md": b"readme",
        }
        smoke = b"wav-smoke"
        root = "fixed-model"
        model_lock = {
            "root": root,
            "files": {
                name: [len(payload), hashlib.sha256(payload).hexdigest()]
                for name, payload in files.items()
            },
            "smoke": [
                "test_wavs/zh.wav",
                len(smoke),
                hashlib.sha256(smoke).hexdigest(),
            ],
        }
        with tempfile.TemporaryDirectory() as directory:
            parent = Path(directory)
            archive_path = parent / "model.tar.bz2"
            with tarfile.open(archive_path, "w:bz2") as archive:
                for name, payload in {
                    **files,
                    "test_wavs/zh.wav": smoke,
                    "test_wavs/en.wav": b"must-not-install",
                    "export-onnx.py": b"must-not-install",
                }.items():
                    info = tarfile.TarInfo(f"{root}/{name}")
                    info.size = len(payload)
                    archive.addfile(info, io.BytesIO(payload))
            model_dir = parent / "installed-model"
            smoke_path = parent / "zh.wav"
            installer._materialize_model(
                archive_path, model_lock, model_dir, smoke_path
            )
            self.assertEqual(
                sorted(path.name for path in model_dir.iterdir()), sorted(files)
            )
            self.assertEqual(smoke_path.read_bytes(), smoke)
            self.assertFalse((model_dir / "export-onnx.py").exists())
            self.assertFalse((model_dir / "test_wavs").exists())

    def test_archive_rejects_links_and_integrity_mismatch(self):
        payload = b"locked"
        model_lock = {
            "root": "fixed-model",
            "files": {
                name: [len(payload), hashlib.sha256(payload).hexdigest()]
                for name in ("model.int8.onnx", "tokens.txt", "LICENSE", "README.md")
            },
            "smoke": [
                "test_wavs/zh.wav",
                len(payload),
                hashlib.sha256(payload).hexdigest(),
            ],
        }
        with tempfile.TemporaryDirectory() as directory:
            parent = Path(directory)
            archive_path = parent / "bad.tar.bz2"
            with tarfile.open(archive_path, "w:bz2") as archive:
                link = tarfile.TarInfo("fixed-model/link")
                link.type = tarfile.SYMTYPE
                link.linkname = "../../outside"
                archive.addfile(link)
            with self.assertRaisesRegex(RuntimeError, "model-archive-invalid"):
                installer._materialize_model(
                    archive_path,
                    model_lock,
                    parent / "model",
                    parent / "smoke.wav",
                )

    def test_install_lock_publish_rollback_and_recovery(self):
        with tempfile.TemporaryDirectory() as directory:
            parent = Path(directory)
            lock_path = parent / ".install.lock"
            with installer._install_lock(lock_path):
                with self.assertRaisesRegex(RuntimeError, "install-busy"):
                    with installer._install_lock(lock_path):
                        self.fail("second owner acquired install lock")

            target = parent / "runtime"
            payload = parent / "payload"
            target.mkdir()
            payload.mkdir()
            (target / "old").write_text("ready", encoding="utf-8")
            (payload / "new").write_text("ready", encoding="utf-8")
            real_replace = os.replace

            def fail_publish(source, destination):
                if Path(source) == payload and Path(destination) == target:
                    raise OSError("synthetic publish failure")
                real_replace(source, destination)

            with mock.patch.object(installer.os, "replace", side_effect=fail_publish):
                with self.assertRaisesRegex(OSError, "synthetic publish failure"):
                    installer._publish_payload(payload, target)
            self.assertEqual((target / "old").read_text(encoding="utf-8"), "ready")

            backup = installer._backup_target(target)
            os.replace(target, backup)
            installer._recover_publish(target)
            self.assertEqual((target / "old").read_text(encoding="utf-8"), "ready")

    def test_runtime_target_is_abi_scoped(self):
        with tempfile.TemporaryDirectory() as directory:
            fingerprint = installer.runtime_fingerprint(
                identity="cp312-macos-arm64",
                cache_tag="cpython-312",
                soabi="cpython-312-darwin",
            )
            target = installer.runtime_target(directory, fingerprint=fingerprint)
            self.assertEqual(target.parent.name, fingerprint)
            self.assertEqual(target.name, "sherpa-onnx-1.13.4")


if __name__ == "__main__":
    unittest.main()
