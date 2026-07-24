#!/usr/bin/env python3
"""Explicit, hash-locked installer for the optional Silero shadow runtime."""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

import silero_shadow


ROOT = Path(__file__).resolve().parent
LOCK_PATH = ROOT / "vad-runtime-lock.json"
INSTALL_TIMEOUT_SECONDS = 300
VERIFY_TIMEOUT_SECONDS = 30
PURE_SPECS = (
    "coloredlogs==15.0.1",
    "flatbuffers==25.9.23",
    "humanfriendly==10.0",
)


def _load_lock():
    try:
        data = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
    except Exception as error:
        raise RuntimeError("lock-invalid") from error
    if (
        not isinstance(data, dict)
        or set(data) != {"schemaVersion", "index", "packages"}
        or data.get("schemaVersion") != 1
        or data.get("index") != "https://pypi.org/simple"
        or not isinstance(data.get("packages"), dict)
    ):
        raise RuntimeError("lock-invalid")
    return data


def _hash_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        while True:
            chunk = handle.read(64 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


@contextmanager
def _install_lock(lock_path):
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    handle = lock_path.open("a+b")
    handle.seek(0)
    handle.write(b"\0")
    handle.flush()
    try:
        if os.name == "nt":
            import msvcrt

            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl

            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except Exception as error:
        handle.close()
        raise RuntimeError("install-busy") from error
    try:
        yield
    finally:
        try:
            if os.name == "nt":
                import msvcrt

                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        finally:
            handle.close()


def _run_fixed(command, *, timeout):
    try:
        result = subprocess.run(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=timeout,
            env={**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"},
        )
    except Exception as error:
        raise RuntimeError("subprocess-failed") from error
    if result.returncode != 0:
        raise RuntimeError("subprocess-failed")


def _verify_target(target, model_dir):
    _run_fixed(
        [
            sys.executable,
            os.fspath(Path(__file__).resolve()),
            "--verify",
            "--target",
            os.fspath(target),
            "--model-dir",
            os.fspath(model_dir),
        ],
        timeout=VERIFY_TIMEOUT_SECONDS,
    )


def _verify_wheels(download_dir, specs, lock):
    wheels = sorted(Path(download_dir).glob("*.whl"))
    if len(wheels) != len(specs):
        raise RuntimeError("wheel-set-invalid")
    remaining = set(specs)
    for wheel in wheels:
        matches = [
            spec
            for spec in remaining
            if wheel.name in lock["packages"].get(spec, {})
        ]
        if len(matches) != 1:
            raise RuntimeError("wheel-set-invalid")
        spec = matches[0]
        expected = lock["packages"][spec][wheel.name]
        if _hash_file(wheel) != expected:
            raise RuntimeError("wheel-integrity-failed")
        remaining.remove(spec)
    if remaining:
        raise RuntimeError("wheel-set-invalid")
    return wheels


def _backup_target(target):
    return target.parent / f".{target.name}.previous"


def _recover_publish(target):
    """Recover the only two crash states left by the sibling directory swap."""

    backup = _backup_target(target)
    if target.exists():
        if backup.exists():
            shutil.rmtree(backup)
        return
    if backup.exists():
        os.replace(backup, target)


def _publish_payload(payload, target):
    """Publish a verified target while retaining the old target until swap succeeds."""

    backup = _backup_target(target)
    if backup.exists():
        shutil.rmtree(backup)
    had_target = target.exists()
    if had_target:
        os.replace(target, backup)
    try:
        os.replace(payload, target)
    except Exception:
        if had_target and backup.exists() and not target.exists():
            os.replace(backup, target)
        raise
    if backup.exists():
        shutil.rmtree(backup)


def _cleanup_staging(parent, limit=8):
    removed = 0
    for candidate in parent.glob(".vad-staging-*"):
        if removed >= limit:
            break
        if candidate.is_dir() and not candidate.is_symlink():
            shutil.rmtree(candidate, ignore_errors=True)
            removed += 1


def install(runtime_root):
    ort_version, reason = silero_shadow.expected_ort_version()
    if ort_version is None:
        raise RuntimeError(reason)
    model_path = silero_shadow.validate_model_resources()
    model_dir = model_path.parent
    fingerprint = silero_shadow.runtime_fingerprint()
    target = silero_shadow.runtime_target(
        runtime_root,
        ort_version,
        fingerprint=fingerprint,
    )
    lock = _load_lock()
    ort_spec = f"onnxruntime=={ort_version}"
    specs = (*PURE_SPECS, ort_spec)
    if any(spec not in lock["packages"] for spec in specs):
        raise RuntimeError("lock-invalid")

    parent = target.parent
    parent.mkdir(parents=True, exist_ok=True)
    lock_file = parent / ".install.lock"
    with _install_lock(lock_file):
        _recover_publish(target)
        _cleanup_staging(parent)
        marker = target / silero_shadow.RUNTIME_MARKER
        if marker.is_file():
            try:
                if marker.read_text(encoding="utf-8").strip() == f"onnxruntime={ort_version}":
                    _verify_target(target, model_dir)
                    return target
            except Exception:
                pass

        staging_root = Path(tempfile.mkdtemp(prefix=".vad-staging-", dir=parent))
        download_dir = staging_root / "downloads"
        payload_dir = staging_root / "payload"
        download_dir.mkdir()
        payload_dir.mkdir()
        try:
            print("正在下载经过哈希锁定的 VAD runtime…", flush=True)
            _run_fixed(
                [
                    sys.executable,
                    "-m",
                    "pip",
                    "download",
                    "--disable-pip-version-check",
                    "--only-binary=:all:",
                    "--no-deps",
                    "--index-url",
                    lock["index"],
                    "--dest",
                    os.fspath(download_dir),
                    *specs,
                ],
                timeout=INSTALL_TIMEOUT_SECONDS,
            )
            wheels = _verify_wheels(download_dir, specs, lock)
            print("正在验证并安装隔离 runtime…", flush=True)
            _run_fixed(
                [
                    sys.executable,
                    "-m",
                    "pip",
                    "install",
                    "--disable-pip-version-check",
                    "--no-deps",
                    "--target",
                    os.fspath(payload_dir),
                    *[os.fspath(wheel) for wheel in wheels],
                ],
                timeout=INSTALL_TIMEOUT_SECONDS,
            )
            _verify_target(payload_dir, model_dir)
            marker = payload_dir / silero_shadow.RUNTIME_MARKER
            marker.write_text(f"onnxruntime={ort_version}\n", encoding="utf-8")
            _publish_payload(payload_dir, target)
            print("实验性 VAD runtime 已就绪，请保存设置以重启语音服务。", flush=True)
            return target
        finally:
            shutil.rmtree(staging_root, ignore_errors=True)


def verify(target, model_dir):
    ort_version, reason = silero_shadow.expected_ort_version()
    if ort_version is None:
        raise RuntimeError(reason)
    model_path = silero_shadow.validate_model_resources(model_dir)
    scorer = silero_shadow.SileroOnnxScorer(
        model_path,
        runtime_path=target,
        expected_ort_version=ort_version,
    )
    try:
        probability = scorer(bytes(silero_shadow.FRAME_SAMPLES * 2))
        if not (0.0 <= probability <= 1.0):
            raise RuntimeError("model-contract-mismatch")
    finally:
        scorer.close()


def main():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--verify", action="store_true")
    parser.add_argument("--target")
    parser.add_argument("--model-dir")
    args = parser.parse_args()
    if args.verify:
        if not args.target or not args.model_dir:
            raise SystemExit(2)
        verify(Path(args.target), Path(args.model_dir))
        return
    runtime_root = os.environ.get("KXYY_VAD_RUNTIME_ROOT")
    if not runtime_root:
        raise SystemExit("VAD runtime 安装失败（runtime-root-unavailable）")
    try:
        install(Path(runtime_root))
    except Exception as error:
        reason = str(error)
        if not reason or not all(ch.islower() or ch.isdigit() or ch == "-" for ch in reason):
            reason = "install-failed"
        raise SystemExit(f"VAD runtime 安装失败（{reason}）") from None


if __name__ == "__main__":
    main()
