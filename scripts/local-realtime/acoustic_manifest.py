"""Offline validator for redistributable realtime acoustic replay artifacts."""

import hashlib
import json
from pathlib import Path, PurePosixPath
import re


SCHEMA_VERSION = 1
MAX_ARTIFACTS = 64
MAX_ARTIFACT_BYTES = 2 * 1024 * 1024
MAX_TOTAL_BYTES = 64 * 1024 * 1024
SYNTHETIC_ARTIFACT_LICENSES = frozenset(
    ("CC0-1.0", "MIT", "BSD-2-Clause", "BSD-3-Clause")
)
ALLOWED_ENCODINGS = frozenset(("generated-pcm-s16le",))
TOP_LEVEL_FIELDS = frozenset(("schemaVersion", "recordingContent", "artifacts"))
ARTIFACT_FIELDS = frozenset(
    (
        "id",
        "kind",
        "relativePath",
        "byteLength",
        "sha256",
        "containsRecordedAudio",
        "materialization",
        "license",
        "provenance",
        "audio",
        "scenarioTags",
    )
)
LICENSE_FIELDS = frozenset(
    (
        "spdxId",
        "url",
        "redistributionAllowed",
        "commercialUseAllowed",
        "derivativesAllowed",
    )
)
PROVENANCE_FIELDS = frozenset(("type", "creator", "sourceUrl"))
AUDIO_FIELDS = frozenset(("sampleRate", "channels", "encoding", "frameSamples"))
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")


class AcousticManifestError(ValueError):
    pass


def _require(condition, message):
    if not condition:
        raise AcousticManifestError(message)


def _require_exact_fields(value, allowed, name):
    _require(isinstance(value, dict), f"{name} must be an object")
    _require(set(value) == allowed, f"{name} fields do not match schema v1")


def _safe_artifact_path(repo_root, relative_path):
    _require(isinstance(relative_path, str) and relative_path, "relativePath is required")
    pure = PurePosixPath(relative_path)
    _require(not pure.is_absolute(), "artifact path must be relative")
    _require(".." not in pure.parts and "." not in pure.parts, "artifact path traversal is forbidden")
    _require("\\" not in relative_path, "artifact path must use POSIX separators")

    root = Path(repo_root).resolve(strict=True)
    candidate = (root / Path(*pure.parts)).resolve(strict=True)
    try:
        candidate.relative_to(root)
    except ValueError as error:
        raise AcousticManifestError("artifact resolves outside the repository") from error
    _require(candidate.is_file(), "artifact must be a regular file")
    return candidate


def _validate_license(value):
    _require_exact_fields(value, LICENSE_FIELDS, "license")
    license_id = value.get("spdxId")
    _require(
        license_id in SYNTHETIC_ARTIFACT_LICENSES,
        "synthetic artifact license is not accepted by schema v1",
    )
    _require(isinstance(value.get("url"), str) and value["url"].startswith("https://"), "license URL must use HTTPS")
    for field in ("redistributionAllowed", "commercialUseAllowed", "derivativesAllowed"):
        _require(value.get(field) is True, f"{field} must be true")


def _validate_provenance(value):
    _require_exact_fields(value, PROVENANCE_FIELDS, "provenance")
    _require(value.get("type") == "project-generated", "schema v1 accepts only project-generated provenance")
    _require(isinstance(value.get("creator"), str) and 0 < len(value["creator"]) <= 160, "provenance creator is required")
    _require(isinstance(value.get("sourceUrl"), str) and value["sourceUrl"].startswith("https://"), "provenance sourceUrl must use HTTPS")


def _validate_audio(value):
    _require_exact_fields(value, AUDIO_FIELDS, "audio")
    _require(value.get("sampleRate") == 16000, "audio sampleRate must be 16000")
    _require(value.get("channels") == 1, "audio channels must be mono")
    _require(value.get("encoding") in ALLOWED_ENCODINGS, "unsupported audio encoding")
    frame_samples = value.get("frameSamples")
    _require(
        not isinstance(frame_samples, bool)
        and isinstance(frame_samples, int)
        and 0 < frame_samples <= 16000,
        "audio frameSamples must be a bounded positive integer",
    )


def validate_acoustic_manifest(manifest_path, repo_root):
    """Validate and return normalized metadata without returning artifact content."""

    manifest_path = Path(manifest_path)
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise AcousticManifestError("manifest is not readable JSON") from error

    _require(isinstance(manifest, dict), "manifest root must be an object")
    _require_exact_fields(manifest, TOP_LEVEL_FIELDS, "manifest")
    _require(manifest.get("schemaVersion") == SCHEMA_VERSION, "unsupported schemaVersion")
    _require(
        manifest.get("recordingContent") == "synthetic-only",
        "schema v1 must contain no recorded audio",
    )
    artifacts = manifest.get("artifacts")
    _require(isinstance(artifacts, list) and 0 < len(artifacts) <= MAX_ARTIFACTS, "artifacts must be a bounded non-empty list")

    seen_ids = set()
    seen_paths = set()
    normalized = []
    total_bytes = 0
    for artifact in artifacts:
        _require_exact_fields(artifact, ARTIFACT_FIELDS, "artifact")
        artifact_id = artifact.get("id")
        _require(isinstance(artifact_id, str) and ID_RE.fullmatch(artifact_id), "artifact id is invalid")
        _require(artifact_id not in seen_ids, "artifact ids must be unique")
        seen_ids.add(artifact_id)

        kind = artifact.get("kind")
        _require(kind == "synthetic-spec", "schema v1 accepts only synthetic specs")
        _require(artifact.get("containsRecordedAudio") is False, "schema v1 forbids recorded audio")
        _require(artifact.get("materialization") == "runtime-generated", "synthetic PCM must be generated at test runtime")
        relative_path = artifact.get("relativePath")
        _require(relative_path not in seen_paths, "artifact paths must be unique")
        seen_paths.add(relative_path)
        artifact_path = _safe_artifact_path(repo_root, relative_path)

        byte_length = artifact_path.stat().st_size
        _require(0 < byte_length <= MAX_ARTIFACT_BYTES, "artifact byte length exceeds the fixed limit")
        _require(artifact.get("byteLength") == byte_length, "artifact byteLength does not match")
        total_bytes += byte_length
        _require(total_bytes <= MAX_TOTAL_BYTES, "total artifact bytes exceed the fixed limit")

        expected_hash = artifact.get("sha256")
        _require(isinstance(expected_hash, str) and SHA256_RE.fullmatch(expected_hash), "artifact sha256 must be lowercase hex")
        actual_hash = hashlib.sha256(artifact_path.read_bytes()).hexdigest()
        _require(actual_hash == expected_hash, "artifact sha256 does not match")

        _validate_license(artifact.get("license"))
        _validate_provenance(artifact.get("provenance"))
        _validate_audio(artifact.get("audio"))
        tags = artifact.get("scenarioTags")
        _require(
            isinstance(tags, list)
            and 0 < len(tags) <= 32
            and all(isinstance(tag, str) and 0 < len(tag) <= 48 for tag in tags),
            "scenarioTags must be a bounded non-empty string list",
        )

        normalized.append(
            {
                "id": artifact_id,
                "kind": kind,
                "relativePath": relative_path,
                "byteLength": byte_length,
                "sha256": actual_hash,
            }
        )

    return {
        "schemaVersion": SCHEMA_VERSION,
        "artifactCount": len(normalized),
        "totalBytes": total_bytes,
        "artifacts": tuple(normalized),
    }
