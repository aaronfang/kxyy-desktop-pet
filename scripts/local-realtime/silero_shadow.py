"""Capability-gated Silero VAD v6.2.1 shadow scorer.

The model is a fixed, hash-verified application resource.  ONNX Runtime remains
an explicit optional install in an App-managed target directory.  This module
never downloads or installs anything during voice-service startup, and its
fixed failure reasons never contain paths, exception text, PCM, or user data.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import importlib
import importlib.util
import json
import math
import os
from pathlib import Path
import platform
import re
import struct
import sys
import sysconfig

from vad_adapter import (
    NeuralVadPipeline,
    ProbabilityVadState,
    SILERO_VAD_CONFIG_REVISION,
)


MODEL_ID = "silero-vad-v6.2.1-16k-op15"
MODEL_FILENAME = "silero_vad_16k_op15.onnx"
MODEL_BYTES = 1_289_603
MODEL_SHA256 = "7ed98ddbad84ccac4cd0aeb3099049280713df825c610a8ed34543318f1b2c49"
LICENSE_FILENAME = "LICENSE"
LICENSE_BYTES = 1_076
LICENSE_SHA256 = "51c19c8be941a3fb00ccf58f0bf9053de9f7237a0b37327896eabad32dffe873"
MANIFEST_FILENAME = "manifest.json"
UPSTREAM_TAG = "v6.2.1"
UPSTREAM_COMMIT = "7e30209a3e901f9842f81b225f3e93d8199902b1"
SAMPLE_RATE = 16_000
FRAME_SAMPLES = 512
CONTEXT_SAMPLES = 64
STATE_SHAPE = (2, 1, 128)
SHADOW_MODE = "silero-onnx-shadow-v1"
RUNTIME_MARKER = ".kxyy-ort-ready"
HASH_CHUNK_BYTES = 64 * 1024

STATUS_DISABLED = "disabled"
STATUS_UNAVAILABLE = "unavailable"
STATUS_READY = "ready"

REASON_NONE = "none"
REASON_USER_DISABLED = "user-disabled"
REASON_UNSUPPORTED_OS = "unsupported-os"
REASON_UNSUPPORTED_ARCH = "unsupported-arch"
REASON_UNSUPPORTED_PYTHON = "unsupported-python"
REASON_RUNTIME_NOT_INSTALLED = "runtime-not-installed"
REASON_RUNTIME_VERSION_MISMATCH = "runtime-version-mismatch"
REASON_RUNTIME_IMPORT_FAILED = "runtime-import-failed"
REASON_CPU_PROVIDER_MISSING = "cpu-provider-missing"
REASON_MODEL_MISSING = "model-missing"
REASON_MODEL_INTEGRITY_FAILED = "model-integrity-failed"
REASON_MODEL_CONTRACT_MISMATCH = "model-contract-mismatch"

FIXED_REASONS = frozenset(
    (
        REASON_NONE,
        REASON_USER_DISABLED,
        REASON_UNSUPPORTED_OS,
        REASON_UNSUPPORTED_ARCH,
        REASON_UNSUPPORTED_PYTHON,
        REASON_RUNTIME_NOT_INSTALLED,
        REASON_RUNTIME_VERSION_MISMATCH,
        REASON_RUNTIME_IMPORT_FAILED,
        REASON_CPU_PROVIDER_MISSING,
        REASON_MODEL_MISSING,
        REASON_MODEL_INTEGRITY_FAILED,
        REASON_MODEL_CONTRACT_MISMATCH,
    )
)


class SileroUnavailable(RuntimeError):
    def __init__(self, reason):
        fixed = reason if reason in FIXED_REASONS else REASON_RUNTIME_IMPORT_FAILED
        super().__init__(fixed)
        self.reason = fixed


@dataclass(frozen=True)
class SileroCapability:
    status: str
    reason: str
    mode: str
    ort_version: str | None = None
    runtime_path: Path | None = None
    model_path: Path | None = None

    @property
    def config_revision(self):
        return (
            SILERO_VAD_CONFIG_REVISION
            if self.status == STATUS_READY and self.mode == SHADOW_MODE
            else "none"
        )

    @property
    def ready(self):
        return self.status == STATUS_READY

    def pipeline_factory(self):
        if not self.ready or self.model_path is None or self.runtime_path is None:
            return None
        model_path = self.model_path
        runtime_path = self.runtime_path
        ort_version = self.ort_version

        def create_pipeline():
            scorer = SileroOnnxScorer(
                model_path,
                runtime_path=runtime_path,
                expected_ort_version=ort_version,
            )
            return NeuralVadPipeline(
                scorer,
                ProbabilityVadState(
                    speech_threshold=0.7,
                    release_threshold=0.35,
                    confirm_frames=3,
                    reject_frames=3,
                    end_frames=8,
                    # 96 model frames = 3.072s. This is a shadow/offline
                    # mechanical ceiling, not a validated live threshold.
                    candidate_max_frames=96,
                ),
            )

        return create_pipeline


def _normalized_machine(machine=None):
    value = str(machine or platform.machine()).strip().lower()
    aliases = {
        "amd64": "x86_64",
        "x64": "x86_64",
        "aarch64": "arm64",
    }
    return aliases.get(value, value)


def _mac_major(version=None):
    text = str(version if version is not None else platform.mac_ver()[0]).strip()
    match = re.match(r"^(\d+)(?:\.|$)", text)
    return int(match.group(1)) if match else 0


def expected_ort_version(
    *,
    system=None,
    machine=None,
    python_version=None,
    python_implementation=None,
    mac_version=None,
    pointer_bits=None,
):
    system = str(system or platform.system()).strip().lower()
    machine = _normalized_machine(machine)
    implementation = str(
        python_implementation or platform.python_implementation()
    ).strip().lower()
    version = python_version or sys.version_info[:2]
    try:
        major, minor = int(version[0]), int(version[1])
    except (TypeError, ValueError, IndexError):
        return None, REASON_UNSUPPORTED_PYTHON
    if implementation != "cpython" or major != 3 or minor < 10 or minor > 14:
        return None, REASON_UNSUPPORTED_PYTHON
    try:
        bits = int(pointer_bits or struct.calcsize("P") * 8)
    except (TypeError, ValueError):
        return None, REASON_UNSUPPORTED_ARCH
    if bits != 64:
        return None, REASON_UNSUPPORTED_ARCH

    if system == "windows":
        if machine != "x86_64":
            return None, REASON_UNSUPPORTED_ARCH
        return ("1.27.0" if minor == 14 else "1.23.2"), REASON_NONE

    if system == "darwin":
        if machine not in ("arm64", "x86_64"):
            return None, REASON_UNSUPPORTED_ARCH
        required_macos = 14 if minor == 14 else 13
        if _mac_major(mac_version) < required_macos:
            return None, REASON_UNSUPPORTED_OS
        if machine == "x86_64" and minor == 14:
            return None, REASON_UNSUPPORTED_PYTHON
        return ("1.27.0" if minor == 14 else "1.23.2"), REASON_NONE

    return None, REASON_UNSUPPORTED_OS


def runtime_fingerprint(
    *,
    system=None,
    machine=None,
    cache_tag=None,
    soabi=None,
    pointer_bits=None,
):
    system = str(system or platform.system()).strip().lower()
    machine = _normalized_machine(machine)
    tag = str(cache_tag or getattr(sys.implementation, "cache_tag", "")).lower()
    abi = str(soabi if soabi is not None else sysconfig.get_config_var("SOABI") or "")
    abi_digest = hashlib.sha256(abi.encode("utf-8")).hexdigest()[:12]
    bits = str(pointer_bits or struct.calcsize("P") * 8)
    pieces = (system, machine, tag, bits, abi_digest)
    if any(not re.fullmatch(r"[a-z0-9_-]+", piece or "") for piece in pieces):
        raise SileroUnavailable(REASON_UNSUPPORTED_PYTHON)
    return "-".join(pieces)


def runtime_target(runtime_root, ort_version, *, fingerprint=None):
    root = Path(runtime_root)
    identity = fingerprint or runtime_fingerprint()
    if not re.fullmatch(r"[a-z0-9_-]+", identity):
        raise SileroUnavailable(REASON_UNSUPPORTED_PYTHON)
    if not re.fullmatch(r"\d+\.\d+\.\d+", str(ort_version)):
        raise SileroUnavailable(REASON_RUNTIME_VERSION_MISMATCH)
    return root / identity / f"onnxruntime-{ort_version}"


def _sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        while True:
            chunk = handle.read(HASH_CHUNK_BYTES)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def _safe_relative_name(value, expected):
    if value != expected or Path(value).name != value or "\\" in value:
        raise SileroUnavailable(REASON_MODEL_INTEGRITY_FAILED)
    return value


def validate_model_resources(model_dir=None):
    root = Path(model_dir or Path(__file__).resolve().parent / "models" / "silero-v6.2.1")
    manifest_path = root / MANIFEST_FILENAME
    if not manifest_path.is_file():
        raise SileroUnavailable(REASON_MODEL_MISSING)
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception as error:
        raise SileroUnavailable(REASON_MODEL_INTEGRITY_FAILED) from error

    expected_top = {"schemaVersion", "modelId", "upstream", "model", "license", "modified"}
    if not isinstance(manifest, dict) or set(manifest) != expected_top:
        raise SileroUnavailable(REASON_MODEL_INTEGRITY_FAILED)
    if (
        manifest.get("schemaVersion") != 1
        or manifest.get("modelId") != MODEL_ID
        or manifest.get("modified") is not False
    ):
        raise SileroUnavailable(REASON_MODEL_INTEGRITY_FAILED)

    upstream = manifest.get("upstream")
    if not isinstance(upstream, dict) or set(upstream) != {"repository", "tag", "commit"}:
        raise SileroUnavailable(REASON_MODEL_INTEGRITY_FAILED)
    if upstream != {
        "repository": "https://github.com/snakers4/silero-vad",
        "tag": UPSTREAM_TAG,
        "commit": UPSTREAM_COMMIT,
    }:
        raise SileroUnavailable(REASON_MODEL_INTEGRITY_FAILED)

    model = manifest.get("model")
    expected_model = {
        "path": MODEL_FILENAME,
        "byteLength": MODEL_BYTES,
        "sha256": MODEL_SHA256,
        "sampleRate": SAMPLE_RATE,
        "frameSamples": FRAME_SAMPLES,
        "contextSamples": CONTEXT_SAMPLES,
        "signature": MODEL_ID,
    }
    if not isinstance(model, dict) or model != expected_model:
        raise SileroUnavailable(REASON_MODEL_INTEGRITY_FAILED)

    license_info = manifest.get("license")
    expected_license = {
        "spdx": "MIT",
        "path": LICENSE_FILENAME,
        "byteLength": LICENSE_BYTES,
        "sha256": LICENSE_SHA256,
    }
    if not isinstance(license_info, dict) or license_info != expected_license:
        raise SileroUnavailable(REASON_MODEL_INTEGRITY_FAILED)

    model_path = root / _safe_relative_name(model["path"], MODEL_FILENAME)
    license_path = root / _safe_relative_name(license_info["path"], LICENSE_FILENAME)
    for path, size, digest in (
        (model_path, MODEL_BYTES, MODEL_SHA256),
        (license_path, LICENSE_BYTES, LICENSE_SHA256),
    ):
        if not path.is_file() or path.is_symlink():
            raise SileroUnavailable(REASON_MODEL_MISSING)
        try:
            if path.stat().st_size != size or _sha256_file(path) != digest:
                raise SileroUnavailable(REASON_MODEL_INTEGRITY_FAILED)
        except SileroUnavailable:
            raise
        except Exception as error:
            raise SileroUnavailable(REASON_MODEL_INTEGRITY_FAILED) from error
    return model_path


def probe_capability(*, enabled, runtime_root=None, model_dir=None, platform_args=None):
    if not enabled:
        return SileroCapability(STATUS_DISABLED, REASON_USER_DISABLED, STATUS_DISABLED)

    platform_args = dict(platform_args or {})
    ort_version, reason = expected_ort_version(**platform_args)
    if ort_version is None:
        return SileroCapability(STATUS_UNAVAILABLE, reason, STATUS_UNAVAILABLE)

    try:
        model_path = validate_model_resources(model_dir)
    except SileroUnavailable as error:
        return SileroCapability(STATUS_UNAVAILABLE, error.reason, STATUS_UNAVAILABLE)

    if runtime_root is None:
        return SileroCapability(
            STATUS_UNAVAILABLE,
            REASON_RUNTIME_NOT_INSTALLED,
            STATUS_UNAVAILABLE,
        )
    try:
        target = runtime_target(runtime_root, ort_version)
        marker = target / RUNTIME_MARKER
        marker_text = marker.read_text(encoding="utf-8").strip()
    except Exception:
        return SileroCapability(
            STATUS_UNAVAILABLE,
            REASON_RUNTIME_NOT_INSTALLED,
            STATUS_UNAVAILABLE,
        )
    if marker_text != f"onnxruntime={ort_version}":
        return SileroCapability(
            STATUS_UNAVAILABLE,
            REASON_RUNTIME_VERSION_MISMATCH,
            STATUS_UNAVAILABLE,
        )
    return SileroCapability(
        STATUS_READY,
        REASON_NONE,
        SHADOW_MODE,
        ort_version=ort_version,
        runtime_path=target,
        model_path=model_path,
    )


def capability_from_environment():
    enabled = os.environ.get("KXYY_VAD_SHADOW") == "1"
    runtime_root = os.environ.get("KXYY_VAD_RUNTIME_ROOT")
    return probe_capability(enabled=enabled, runtime_root=runtime_root)


def _activate_runtime(runtime_path):
    text = os.fspath(runtime_path)
    if text not in sys.path:
        # Append so the voice environment's existing NumPy/Torch stack wins.
        sys.path.append(text)
    importlib.invalidate_caches()


def _load_onnxruntime(runtime_path):
    target = Path(runtime_path).resolve()
    package_dir = target / "onnxruntime"
    init_path = package_dir / "__init__.py"
    if not init_path.is_file() or init_path.is_symlink():
        raise SileroUnavailable(REASON_RUNTIME_NOT_INSTALLED)
    loaded = sys.modules.get("onnxruntime")
    if loaded is not None:
        try:
            loaded_path = Path(loaded.__file__).resolve()
            loaded_path.relative_to(target)
            return loaded
        except Exception as error:
            raise SileroUnavailable(REASON_RUNTIME_IMPORT_FAILED) from error
    spec = importlib.util.spec_from_file_location(
        "onnxruntime",
        init_path,
        submodule_search_locations=[os.fspath(package_dir)],
    )
    if spec is None or spec.loader is None:
        raise SileroUnavailable(REASON_RUNTIME_IMPORT_FAILED)
    module = importlib.util.module_from_spec(spec)
    sys.modules["onnxruntime"] = module
    try:
        spec.loader.exec_module(module)
    except Exception as error:
        sys.modules.pop("onnxruntime", None)
        raise SileroUnavailable(REASON_RUNTIME_IMPORT_FAILED) from error
    return module


class SileroOnnxScorer:
    """Fixed 16 kHz/512-sample Silero ONNX contract with recurrent isolation."""

    def __init__(self, model_path, *, runtime_path, expected_ort_version):
        validate_model_resources(Path(model_path).parent)
        _activate_runtime(runtime_path)
        try:
            import numpy as np
            ort = _load_onnxruntime(runtime_path)
        except Exception as error:
            if isinstance(error, SileroUnavailable):
                raise
            raise SileroUnavailable(REASON_RUNTIME_IMPORT_FAILED) from error
        if getattr(ort, "__version__", None) != expected_ort_version:
            raise SileroUnavailable(REASON_RUNTIME_VERSION_MISMATCH)
        try:
            if "CPUExecutionProvider" not in ort.get_available_providers():
                raise SileroUnavailable(REASON_CPU_PROVIDER_MISSING)
            options = ort.SessionOptions()
            options.inter_op_num_threads = 1
            options.intra_op_num_threads = 1
            session = ort.InferenceSession(
                os.fspath(model_path),
                sess_options=options,
                providers=["CPUExecutionProvider"],
            )
        except SileroUnavailable:
            raise
        except Exception as error:
            raise SileroUnavailable(REASON_RUNTIME_IMPORT_FAILED) from error

        self._np = np
        self._session = session
        self._validate_contract()
        self.reset()

    def _validate_contract(self):
        inputs = self._session.get_inputs()
        outputs = self._session.get_outputs()
        input_contract = [(item.name, item.type, item.shape) for item in inputs]
        output_contract = [(item.name, item.type, item.shape) for item in outputs]
        valid_inputs = (
            len(input_contract) == 3
            and input_contract[0][0:2] == ("input", "tensor(float)")
            and len(input_contract[0][2]) == 2
            and input_contract[1][0:2] == ("state", "tensor(float)")
            and len(input_contract[1][2]) == 3
            and input_contract[1][2][0] == 2
            and input_contract[1][2][2] == 128
            and input_contract[2] == ("sr", "tensor(int64)", [])
        )
        valid_outputs = (
            len(output_contract) == 2
            and output_contract[0][0:2] == ("output", "tensor(float)")
            and len(output_contract[0][2]) == 2
            and output_contract[0][2][1] == 1
            and output_contract[1][0:2] == ("stateN", "tensor(float)")
            and len(output_contract[1][2]) == 3
        )
        if not valid_inputs or not valid_outputs:
            raise SileroUnavailable(REASON_MODEL_CONTRACT_MISMATCH)

    def reset(self):
        np = self._np
        self._state = np.zeros(STATE_SHAPE, dtype=np.float32)
        self._context = np.zeros((1, CONTEXT_SAMPLES), dtype=np.float32)

    def __call__(self, frame):
        if not isinstance(frame, (bytes, bytearray, memoryview)):
            raise SileroUnavailable(REASON_MODEL_CONTRACT_MISMATCH)
        raw = bytes(frame)
        if len(raw) != FRAME_SAMPLES * 2:
            raise SileroUnavailable(REASON_MODEL_CONTRACT_MISMATCH)
        np = self._np
        samples = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
        model_input = np.concatenate((self._context, samples.reshape(1, -1)), axis=1)
        sample_rate = np.asarray(SAMPLE_RATE, dtype=np.int64)
        try:
            output, next_state = self._session.run(
                ["output", "stateN"],
                {"input": model_input, "state": self._state, "sr": sample_rate},
            )
        except Exception as error:
            raise SileroUnavailable(REASON_RUNTIME_IMPORT_FAILED) from error
        output = np.asarray(output)
        next_state = np.asarray(next_state)
        if (
            output.shape != (1, 1)
            or output.dtype != np.float32
            or next_state.shape != STATE_SHAPE
            or next_state.dtype != np.float32
            or not np.isfinite(output).all()
            or not np.isfinite(next_state).all()
        ):
            raise SileroUnavailable(REASON_MODEL_CONTRACT_MISMATCH)
        probability = float(output[0, 0])
        if not math.isfinite(probability) or not 0.0 <= probability <= 1.0:
            raise SileroUnavailable(REASON_MODEL_CONTRACT_MISMATCH)
        self._state = next_state.copy()
        self._context = model_input[:, -CONTEXT_SAMPLES:].copy()
        return probability

    def close(self):
        self.reset()
        self._session = None
