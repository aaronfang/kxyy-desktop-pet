#!/usr/bin/env python3
"""Explicit, hash-locked installer for the optional SenseVoice ASR runtime."""

from __future__ import annotations

import argparse
from array import array
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import socket
import ssl
import struct
import subprocess
import sys
import sysconfig
import tarfile
import tempfile
import urllib.request
import wave


ROOT = Path(__file__).resolve().parent
LOCK_PATH = ROOT / "sensevoice-runtime-lock.json"
RUNTIME_VERSION = "1.13.4"
RUNTIME_MARKER = ".kxyy-sensevoice-ready"
INSTALL_TIMEOUT_SECONDS = 300
VERIFY_TIMEOUT_SECONDS = 90
DOWNLOAD_SOCKET_TIMEOUT_SECONDS = 30
DOWNLOAD_CHUNK_BYTES = 64 * 1024
DOWNLOAD_PROGRESS_BYTES = 1024 * 1024
MODEL_DIRNAME = "sensevoice-small-int8-2024-07-17"
PROGRESS_PREFIX = "KXYY_SENSEVOICE_PROGRESS "
MARKER_TEXT = (
    "sherpa-onnx=1.13.4\n"
    "model=sensevoice-small-int8-2024-07-17\n"
)


def _emit_progress(state, phase, message, *, completed_bytes=0, total_bytes=0, reason=""):
    payload = {
        "state": state,
        "phase": phase,
        "message": message,
        "completedBytes": max(0, int(completed_bytes)),
        "totalBytes": max(0, int(total_bytes)),
    }
    if reason:
        payload["reason"] = reason
    print(PROGRESS_PREFIX + json.dumps(payload, ensure_ascii=False, separators=(",", ":")), flush=True)


@contextmanager
def _address_family(family):
    """Limit one urllib attempt to IPv4 or IPv6 without changing system networking."""

    original = socket.getaddrinfo

    def resolve(host, port, requested_family=0, sock_type=0, proto=0, flags=0):
        selected = family if requested_family in (0, socket.AF_UNSPEC) else requested_family
        return original(host, port, selected, sock_type, proto, flags)

    socket.getaddrinfo = resolve
    try:
        yield
    finally:
        socket.getaddrinfo = original


def _hash_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        while True:
            chunk = handle.read(DOWNLOAD_CHUNK_BYTES)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def _valid_artifact(value):
    return bool(
        isinstance(value, list)
        and len(value) == 4
        and isinstance(value[0], str)
        and re.fullmatch(r"[A-Za-z0-9_.-]+", value[0])
        and isinstance(value[1], str)
        and value[1].startswith("https://")
        and isinstance(value[2], int)
        and value[2] > 0
        and isinstance(value[3], str)
        and re.fullmatch(r"[0-9a-f]{64}", value[3])
    )


def _load_lock():
    try:
        data = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
    except Exception as error:
        raise RuntimeError("lock-invalid") from error
    if (
        not isinstance(data, dict)
        or set(data) != {"schemaVersion", "runtimeVersion", "artifacts", "model"}
        or data.get("schemaVersion") != 1
        or data.get("runtimeVersion") != RUNTIME_VERSION
        or not isinstance(data.get("artifacts"), dict)
        or set(data["artifacts"]) != {"sherpa-onnx", "sherpa-onnx-core"}
        or not isinstance(data.get("model"), dict)
        or set(data["model"]) != {"archive", "root", "files", "smoke"}
    ):
        raise RuntimeError("lock-invalid")
    wrapper = data["artifacts"]["sherpa-onnx"]
    core = data["artifacts"]["sherpa-onnx-core"]
    if not isinstance(wrapper, dict) or not isinstance(core, dict):
        raise RuntimeError("lock-invalid")
    expected_wrapper_keys = {
        f"cp3{minor}-{system}-{arch}"
        for minor in range(10, 15)
        for system, arch in (
            ("macos", "arm64"),
            ("macos", "x64"),
            ("windows", "x64"),
        )
    }
    if set(wrapper) != expected_wrapper_keys or set(core) != {
        "macos-arm64",
        "macos-x64",
        "windows-x64",
    }:
        raise RuntimeError("lock-invalid")
    if not all(_valid_artifact(value) for value in (*wrapper.values(), *core.values())):
        raise RuntimeError("lock-invalid")
    model = data["model"]
    if (
        not _valid_artifact(model["archive"])
        or not isinstance(model["root"], str)
        or not re.fullmatch(r"[A-Za-z0-9_.-]+", model["root"])
        or not isinstance(model["files"], dict)
        or set(model["files"]) != {"model.int8.onnx", "tokens.txt", "LICENSE", "README.md"}
        or not isinstance(model["smoke"], list)
        or len(model["smoke"]) != 3
    ):
        raise RuntimeError("lock-invalid")
    for name, value in model["files"].items():
        if (
            not re.fullmatch(r"[A-Za-z0-9_.-]+", name)
            or not isinstance(value, list)
            or len(value) != 2
            or not isinstance(value[0], int)
            or value[0] <= 0
            or not isinstance(value[1], str)
            or not re.fullmatch(r"[0-9a-f]{64}", value[1])
        ):
            raise RuntimeError("lock-invalid")
    smoke = model["smoke"]
    if (
        smoke[0] != "test_wavs/zh.wav"
        or not isinstance(smoke[1], int)
        or smoke[1] <= 0
        or not isinstance(smoke[2], str)
        or not re.fullmatch(r"[0-9a-f]{64}", smoke[2])
    ):
        raise RuntimeError("lock-invalid")
    return data


def _normalize_machine(machine=None):
    value = str(machine or platform.machine()).strip().lower()
    if value in {"amd64", "x86_64"}:
        return "x64"
    if value in {"arm64", "aarch64"}:
        return "arm64"
    return value


def platform_identity(
    *, system=None, machine=None, python_version=None, implementation=None, pointer_bits=None
):
    system_name = str(system or platform.system()).strip().lower()
    arch = _normalize_machine(machine)
    version = python_version or sys.version_info[:2]
    implementation_name = str(
        implementation or getattr(sys.implementation, "name", "")
    ).lower()
    bits = int(pointer_bits or struct.calcsize("P") * 8)
    if implementation_name != "cpython" or bits != 64:
        raise RuntimeError("unsupported-python")
    if not isinstance(version, (tuple, list)) or len(version) < 2 or version[0] != 3:
        raise RuntimeError("unsupported-python")
    minor = int(version[1])
    if minor not in range(10, 15):
        raise RuntimeError("unsupported-python")
    if system_name == "darwin":
        system_key = "macos"
        if arch not in {"arm64", "x64"}:
            raise RuntimeError("unsupported-arch")
    elif system_name == "windows":
        system_key = "windows"
        if arch != "x64":
            raise RuntimeError("unsupported-arch")
    else:
        raise RuntimeError("unsupported-os")
    return f"cp3{minor}-{system_key}-{arch}", f"{system_key}-{arch}"


def runtime_fingerprint(*, identity=None, cache_tag=None, soabi=None):
    wheel_identity = identity or platform_identity()[0]
    tag = str(cache_tag or getattr(sys.implementation, "cache_tag", "")).lower()
    abi = str(soabi if soabi is not None else sysconfig.get_config_var("SOABI") or "")
    digest = hashlib.sha256(abi.encode("utf-8")).hexdigest()[:12]
    fingerprint = f"{wheel_identity}-{tag}-{digest}"
    if not re.fullmatch(r"[a-z0-9_-]+", fingerprint):
        raise RuntimeError("unsupported-python")
    return fingerprint


def runtime_target(runtime_root, *, fingerprint=None):
    identity = fingerprint or runtime_fingerprint()
    if not re.fullmatch(r"[a-z0-9_-]+", identity):
        raise RuntimeError("unsupported-python")
    return Path(runtime_root) / identity / f"sherpa-onnx-{RUNTIME_VERSION}"


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


def _download_artifact(artifact, destination, progress=None):
    filename, url, expected_size, expected_hash = artifact
    destination = Path(destination)
    if destination.name != filename or not url.startswith("https://"):
        raise RuntimeError("download-invalid")
    request = urllib.request.Request(url, headers={"User-Agent": "kxyy-sensevoice-installer/1"})
    context = ssl.create_default_context()
    try:
        import certifi

        context.load_verify_locations(cafile=certifi.where())
    except ImportError:
        pass

    last_error = None
    # Prefer IPv4 because some macOS networks resolve both families but leave the
    # IPv6 transfer established without delivering bytes. IPv6 remains the
    # bounded fallback for IPv6-only networks.
    for family in (socket.AF_INET, socket.AF_INET6):
        destination.unlink(missing_ok=True)
        digest = hashlib.sha256()
        received = 0
        reported = 0
        try:
            with _address_family(family):
                with urllib.request.urlopen(
                    request, timeout=DOWNLOAD_SOCKET_TIMEOUT_SECONDS, context=context
                ) as response:
                    if not str(response.geturl()).startswith("https://"):
                        raise RuntimeError("download-invalid")
                    with destination.open("xb") as output:
                        while True:
                            chunk = response.read(DOWNLOAD_CHUNK_BYTES)
                            if not chunk:
                                break
                            received += len(chunk)
                            if received > expected_size:
                                raise RuntimeError("download-integrity-failed")
                            output.write(chunk)
                            digest.update(chunk)
                            if progress and (
                                received == expected_size
                                or received - reported >= DOWNLOAD_PROGRESS_BYTES
                            ):
                                progress(received, expected_size)
                                reported = received
        except RuntimeError:
            destination.unlink(missing_ok=True)
            raise
        except Exception as error:
            destination.unlink(missing_ok=True)
            last_error = error
            continue
        if received != expected_size or digest.hexdigest() != expected_hash:
            destination.unlink(missing_ok=True)
            raise RuntimeError("download-integrity-failed")
        return destination
    raise RuntimeError("download-failed") from last_error


def _copy_locked_member(archive, member_name, destination, expected_size, expected_hash):
    try:
        member = archive.getmember(member_name)
    except KeyError as error:
        raise RuntimeError("model-archive-invalid") from error
    if not member.isfile() or member.size != expected_size:
        raise RuntimeError("model-archive-invalid")
    source = archive.extractfile(member)
    if source is None:
        raise RuntimeError("model-archive-invalid")
    digest = hashlib.sha256()
    written = 0
    destination = Path(destination)
    with source, destination.open("xb") as output:
        while True:
            chunk = source.read(DOWNLOAD_CHUNK_BYTES)
            if not chunk:
                break
            written += len(chunk)
            if written > expected_size:
                raise RuntimeError("model-integrity-failed")
            output.write(chunk)
            digest.update(chunk)
    if written != expected_size or digest.hexdigest() != expected_hash:
        destination.unlink(missing_ok=True)
        raise RuntimeError("model-integrity-failed")


def _materialize_model(archive_path, model_lock, model_dir, smoke_path):
    model_dir.mkdir()
    root = model_lock["root"]
    try:
        with tarfile.open(archive_path, mode="r:bz2") as archive:
            for member in archive.getmembers():
                path = Path(member.name)
                if path.is_absolute() or ".." in path.parts or member.issym() or member.islnk():
                    raise RuntimeError("model-archive-invalid")
            for name, (size, digest) in model_lock["files"].items():
                _copy_locked_member(
                    archive,
                    f"{root}/{name}",
                    model_dir / name,
                    size,
                    digest,
                )
            smoke_name, smoke_size, smoke_digest = model_lock["smoke"]
            _copy_locked_member(
                archive,
                f"{root}/{smoke_name}",
                smoke_path,
                smoke_size,
                smoke_digest,
            )
    except RuntimeError:
        raise
    except Exception as error:
        raise RuntimeError("model-archive-invalid") from error


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


def _verify_target(target, smoke_path=None):
    command = [
        sys.executable,
        os.fspath(Path(__file__).resolve()),
        "--verify",
        "--target",
        os.fspath(target),
    ]
    if smoke_path is not None:
        command.extend(("--smoke", os.fspath(smoke_path)))
    _run_fixed(command, timeout=VERIFY_TIMEOUT_SECONDS)


def _backup_target(target):
    return target.parent / f".{target.name}.previous"


def _recover_publish(target):
    backup = _backup_target(target)
    if target.exists():
        if backup.exists():
            shutil.rmtree(backup)
        return
    if backup.exists():
        os.replace(backup, target)


def _publish_payload(payload, target):
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
    for candidate in parent.glob(".sensevoice-staging-*"):
        if removed >= limit:
            break
        if candidate.is_dir() and not candidate.is_symlink():
            shutil.rmtree(candidate, ignore_errors=True)
            removed += 1


def install(runtime_root):
    lock = _load_lock()
    wrapper_key, core_key = platform_identity()
    wrapper = lock["artifacts"]["sherpa-onnx"][wrapper_key]
    core = lock["artifacts"]["sherpa-onnx-core"][core_key]
    target = runtime_target(runtime_root)
    parent = target.parent
    parent.mkdir(parents=True, exist_ok=True)
    with _install_lock(parent / ".install.lock"):
        _recover_publish(target)
        _cleanup_staging(parent)
        marker = target / RUNTIME_MARKER
        if marker.is_file():
            try:
                if marker.read_text(encoding="utf-8") == MARKER_TEXT:
                    _emit_progress("installing", "verifying", "正在校验已安装的 SenseVoice runtime…")
                    _verify_target(target)
                    _emit_progress("ready", "complete", "SenseVoice runtime 已就绪。")
                    return target
            except Exception:
                pass

        staging_root = Path(tempfile.mkdtemp(prefix=".sensevoice-staging-", dir=parent))
        downloads = staging_root / "downloads"
        payload = staging_root / "payload"
        downloads.mkdir()
        payload.mkdir()
        smoke_path = staging_root / "zh.wav"
        try:
            artifacts = (
                ("Python 绑定", wrapper),
                ("推理核心", core),
                ("SenseVoice 模型", lock["model"]["archive"]),
            )
            total_download_bytes = sum(artifact[2] for _, artifact in artifacts)
            completed_before = 0
            wheel_paths = []
            downloaded = []
            for index, (label, artifact) in enumerate(artifacts, start=1):
                _emit_progress(
                    "installing",
                    "downloading",
                    f"正在下载 {label}（{index}/3）…",
                    completed_bytes=completed_before,
                    total_bytes=total_download_bytes,
                )

                def report(received, _expected, *, base=completed_before, name=label, item=index):
                    total_received = base + received
                    percent = min(100, total_received * 100 // total_download_bytes)
                    _emit_progress(
                        "installing",
                        "downloading",
                        f"正在下载 {name}（{item}/3，总进度 {percent}%）…",
                        completed_bytes=total_received,
                        total_bytes=total_download_bytes,
                    )

                downloaded.append(
                    _download_artifact(artifact, downloads / artifact[0], progress=report)
                )
                completed_before += artifact[2]
            wheel_paths.extend(downloaded[:2])
            archive_path = downloaded[2]
            _emit_progress("installing", "installing", "正在安装 SenseVoice 推理 runtime…")
            _run_fixed(
                [
                    sys.executable,
                    "-m",
                    "pip",
                    "install",
                    "--disable-pip-version-check",
                    "--no-deps",
                    "--target",
                    os.fspath(payload),
                    *[os.fspath(path) for path in wheel_paths],
                ],
                timeout=INSTALL_TIMEOUT_SECONDS,
            )
            _emit_progress("installing", "extracting", "正在校验并解包 SenseVoice 模型…")
            _materialize_model(
                archive_path,
                lock["model"],
                payload / MODEL_DIRNAME,
                smoke_path,
            )
            _emit_progress("installing", "verifying", "正在运行 SenseVoice 真实推理校验…")
            _verify_target(payload, smoke_path)
            (payload / RUNTIME_MARKER).write_text(MARKER_TEXT, encoding="utf-8")
            _publish_payload(payload, target)
            _emit_progress("ready", "complete", "SenseVoice runtime 已就绪，请重启语音服务。")
            return target
        finally:
            shutil.rmtree(staging_root, ignore_errors=True)


def _read_smoke_wav(path):
    with wave.open(os.fspath(path), "rb") as handle:
        if (
            handle.getnchannels() != 1
            or handle.getsampwidth() != 2
            or handle.getframerate() != 16000
        ):
            raise RuntimeError("smoke-invalid")
        pcm = array("h")
        pcm.frombytes(handle.readframes(handle.getnframes()))
    if sys.byteorder != "little":
        pcm.byteswap()
    return [sample / 32768.0 for sample in pcm]


def verify(target, smoke_path=None):
    target = Path(target)
    model_dir = target / MODEL_DIRNAME
    lock = _load_lock()
    for name, (size, digest) in lock["model"]["files"].items():
        path = model_dir / name
        if (
            not path.is_file()
            or path.is_symlink()
            or path.stat().st_size != size
            or _hash_file(path) != digest
        ):
            raise RuntimeError("model-integrity-failed")
    sys.path.insert(0, os.fspath(target))
    try:
        import sherpa_onnx

        if getattr(sherpa_onnx, "__version__", None) != RUNTIME_VERSION:
            raise RuntimeError("runtime-version-mismatch")
        recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
            model=os.fspath(model_dir / "model.int8.onnx"),
            tokens=os.fspath(model_dir / "tokens.txt"),
            language="zh",
            use_itn=True,
            num_threads=1,
            debug=False,
        )
        stream = recognizer.create_stream()
        samples = (
            _read_smoke_wav(smoke_path)
            if smoke_path is not None
            else [0.0] * 1600
        )
        stream.accept_waveform(16000, samples)
        recognizer.decode_stream(stream)
        text = str(stream.result.text or "")
        if smoke_path is not None and not re.search(r"[\u3400-\u9fff]", text):
            raise RuntimeError("model-contract-mismatch")
    except RuntimeError:
        raise
    except Exception as error:
        raise RuntimeError("model-contract-mismatch") from error
    finally:
        try:
            sys.path.remove(os.fspath(target))
        except ValueError:
            pass


def main():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--verify", action="store_true")
    parser.add_argument("--target")
    parser.add_argument("--smoke")
    args = parser.parse_args()
    if args.verify:
        if not args.target:
            raise SystemExit(2)
        verify(Path(args.target), Path(args.smoke) if args.smoke else None)
        return
    runtime_root = os.environ.get("KXYY_ASR_RUNTIME_ROOT")
    if not runtime_root:
        reason = "runtime-root-unavailable"
        _emit_progress("failed", "failed", "SenseVoice runtime 安装失败：无法定位应用数据目录。", reason=reason)
        raise SystemExit(f"SenseVoice runtime 安装失败（{reason}）")
    try:
        install(Path(runtime_root))
    except Exception as error:
        reason = str(error)
        if not reason or not all(ch.islower() or ch.isdigit() or ch == "-" for ch in reason):
            reason = "install-failed"
        messages = {
            "download-failed": "下载失败，请检查网络后重试。",
            "download-integrity-failed": "下载文件未通过完整性校验。",
            "install-busy": "已有安装任务正在运行。",
            "subprocess-failed": "安装或推理校验子进程失败。",
            "model-archive-invalid": "模型压缩包格式无效。",
            "model-integrity-failed": "模型文件未通过完整性校验。",
            "unsupported-python": "当前 Python 版本不受支持。",
            "unsupported-arch": "当前处理器架构不受支持。",
            "unsupported-os": "当前操作系统不受支持。",
        }
        detail = messages.get(reason, "安装校验失败。")
        _emit_progress("failed", "failed", f"SenseVoice runtime 安装失败：{detail}", reason=reason)
        raise SystemExit(f"SenseVoice runtime 安装失败（{reason}）") from None


if __name__ == "__main__":
    main()
