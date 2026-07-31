import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TAURI_DIR = join(ROOT, "src-tauri");
const config = JSON.parse(readFileSync(join(TAURI_DIR, "tauri.conf.json"), "utf8"));
const resources = config?.bundle?.resources;
const verifyStrippedFrontend = process.argv.includes("--stripped-frontend");

if (!resources || Array.isArray(resources) || typeof resources !== "object") {
  throw new Error("tauri bundle.resources must be an object mapping");
}

const expectedMappings = new Map([
  ["../scripts/local-realtime/silero_shadow.py", "scripts/local-realtime/silero_shadow.py"],
  ["../scripts/local-realtime/install_vad_runtime.py", "scripts/local-realtime/install_vad_runtime.py"],
  ["../scripts/local-realtime/vad-runtime-lock.json", "scripts/local-realtime/vad-runtime-lock.json"],
  ["../scripts/local-realtime/models/silero-v6.2.1", "scripts/local-realtime/models/silero-v6.2.1"],
  ["../scripts/local-realtime/asr_adapter.py", "scripts/local-realtime/asr_adapter.py"],
  ["../scripts/local-realtime/install_sensevoice_runtime.py", "scripts/local-realtime/install_sensevoice_runtime.py"],
  ["../scripts/local-realtime/sensevoice-runtime-lock.json", "scripts/local-realtime/sensevoice-runtime-lock.json"],
  ["../scripts/local-realtime/SENSEVOICE-NOTICE.md", "scripts/local-realtime/SENSEVOICE-NOTICE.md"],
  ["../scripts/local-realtime/server_voxcpm.py", "scripts/local-realtime/server_voxcpm.py"],
  ["../scripts/macos/setup-voxcpm2.sh", "scripts/macos/setup-voxcpm2.sh"],
]);

for (const [source, target] of expectedMappings) {
  if (resources[source] !== target) {
    throw new Error(`missing fixed realtime resource mapping: ${source}`);
  }
  const sourcePath = resolve(TAURI_DIR, source);
  const stat = lstatSync(sourcePath);
  if (source.endsWith("silero-v6.2.1") ? !stat.isDirectory() : !stat.isFile()) {
    throw new Error(`realtime resource mapping must resolve to the expected type: ${source}`);
  }
}

const forbiddenBundlePath =
  /(^|\/)(?:persona-assets\.js|\.persona-assets\.js\.bak|settings\.json|\.env(?:\.[^/]*)?|\.venv[^/]*|__pycache__|[^/]*\.whl|\.vad-staging-[^/]*|\.sensevoice-staging-[^/]*|\.asr-staging-[^/]*|sensevoice-asr-runtime|sensevoice-runtime|sherpa-onnx-sense-voice-[^/]*|huggingface|modelscope|\.cache|downloads?|\.ready|\.kxyy-sensevoice-ready)(?:\/|$)/i;

function relativeBundlePath(path) {
  return relative(ROOT, path).split(sep).join("/");
}

function assertInsideWorkspace(path) {
  const rel = relative(ROOT, path);
  if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
    throw new Error("bundle resource must resolve inside the repository");
  }
}

function scanBundledPath(path) {
  assertInsideWorkspace(path);
  const rel = relativeBundlePath(path);
  if (forbiddenBundlePath.test(`/${rel}`)) {
    throw new Error(`forbidden generated or plaintext bundle resource: ${rel}`);
  }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    throw new Error(`bundle resources must not contain symlinks: ${rel}`);
  }
  if (stat.isDirectory()) {
    for (const child of readdirSync(path)) scanBundledPath(join(path, child));
  } else if (!stat.isFile()) {
    throw new Error(`bundle resource must be a regular file or directory: ${rel}`);
  }
}

for (const [source, target] of Object.entries(resources)) {
  if (forbiddenBundlePath.test(source) || forbiddenBundlePath.test(target)) {
    throw new Error(`forbidden generated or plaintext bundle resource: ${source}`);
  }
  scanBundledPath(resolve(TAURI_DIR, source));
}

if (verifyStrippedFrontend) {
  const frontendRoot = resolve(TAURI_DIR, config?.build?.frontendDist ?? "");
  scanBundledPath(frontendRoot);
}

const modelRoot = join(ROOT, "scripts", "local-realtime", "models", "silero-v6.2.1");
const expectedModelFiles = [
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "manifest.json",
  "silero_vad_16k_op15.onnx",
];
const actualModelFiles = readdirSync(modelRoot).sort();
if (JSON.stringify(actualModelFiles) !== JSON.stringify(expectedModelFiles)) {
  throw new Error("Silero model resource directory contains an unexpected file set");
}

for (const filename of expectedModelFiles) {
  if (!lstatSync(join(modelRoot, filename)).isFile()) {
    throw new Error(`Silero resource must be a regular file: ${filename}`);
  }
}

const manifest = JSON.parse(readFileSync(join(modelRoot, "manifest.json"), "utf8"));
const fixedFiles = [
  [manifest?.model, "silero_vad_16k_op15.onnx"],
  [manifest?.license, "LICENSE"],
];

for (const [entry, expectedPath] of fixedFiles) {
  if (!entry || entry.path !== expectedPath) {
    throw new Error(`Silero manifest path mismatch: ${expectedPath}`);
  }
  const bytes = readFileSync(join(modelRoot, expectedPath));
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (bytes.length !== entry.byteLength || digest !== entry.sha256) {
    throw new Error(`Silero resource integrity mismatch: ${expectedPath}`);
  }
}

const notice = readFileSync(join(modelRoot, "THIRD_PARTY_NOTICES.md"));
if (
  createHash("sha256").update(notice).digest("hex") !==
  "839abac7875017caa4e55ec69059b86837e31114bd7a14228773b06a5aed72df"
) {
  throw new Error("Silero third-party notice integrity mismatch");
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} has an unexpected schema`);
  }
}

function assertLockedArtifact(entry, label, expectedHost) {
  if (
    !Array.isArray(entry) ||
    entry.length !== 4 ||
    typeof entry[0] !== "string" ||
    typeof entry[1] !== "string" ||
    !Number.isSafeInteger(entry[2]) ||
    entry[2] <= 0 ||
    typeof entry[3] !== "string" ||
    !/^[0-9a-f]{64}$/.test(entry[3])
  ) {
    throw new Error(`${label} must be a fixed filename, URL, size and SHA-256 tuple`);
  }
  const url = new URL(entry[1]);
  if (url.protocol !== "https:" || url.hostname !== expectedHost) {
    throw new Error(`${label} must use the audited HTTPS host`);
  }
}

const senseVoiceRoot = join(ROOT, "scripts", "local-realtime");
const senseVoiceLock = JSON.parse(
  readFileSync(join(senseVoiceRoot, "sensevoice-runtime-lock.json"), "utf8"),
);
assertExactKeys(
  senseVoiceLock,
  ["schemaVersion", "runtimeVersion", "artifacts", "model"],
  "SenseVoice runtime lock",
);
if (senseVoiceLock.schemaVersion !== 1 || senseVoiceLock.runtimeVersion !== "1.13.4") {
  throw new Error("SenseVoice runtime lock identity mismatch");
}
assertExactKeys(
  senseVoiceLock.artifacts,
  ["sherpa-onnx", "sherpa-onnx-core"],
  "SenseVoice artifact lock",
);

const expectedWrappers = [];
for (const minor of [10, 11, 12, 13, 14]) {
  expectedWrappers.push(
    `cp3${minor}-macos-arm64`,
    `cp3${minor}-macos-x64`,
    `cp3${minor}-windows-x64`,
  );
}
const expectedCores = ["macos-arm64", "macos-x64", "windows-x64"];
assertExactKeys(
  senseVoiceLock.artifacts["sherpa-onnx"],
  expectedWrappers,
  "SenseVoice wrapper matrix",
);
assertExactKeys(
  senseVoiceLock.artifacts["sherpa-onnx-core"],
  expectedCores,
  "SenseVoice core matrix",
);
for (const [identity, entry] of Object.entries(senseVoiceLock.artifacts["sherpa-onnx"])) {
  assertLockedArtifact(entry, `SenseVoice wrapper ${identity}`, "files.pythonhosted.org");
  if (!entry[0].endsWith(".whl")) throw new Error(`SenseVoice wrapper filename mismatch: ${identity}`);
}
for (const [identity, entry] of Object.entries(senseVoiceLock.artifacts["sherpa-onnx-core"])) {
  assertLockedArtifact(entry, `SenseVoice core ${identity}`, "files.pythonhosted.org");
  if (!entry[0].endsWith(".whl")) throw new Error(`SenseVoice core filename mismatch: ${identity}`);
}

assertExactKeys(
  senseVoiceLock.model,
  ["archive", "root", "files", "smoke"],
  "SenseVoice model lock",
);
assertLockedArtifact(
  senseVoiceLock.model.archive,
  "SenseVoice model archive",
  "github.com",
);
if (
  senseVoiceLock.model.archive[0] !==
    "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2" ||
  senseVoiceLock.model.root !==
    "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17"
) {
  throw new Error("SenseVoice model identity mismatch");
}
assertExactKeys(
  senseVoiceLock.model.files,
  ["model.int8.onnx", "tokens.txt", "LICENSE", "README.md"],
  "SenseVoice installed model file set",
);
for (const [filename, entry] of Object.entries(senseVoiceLock.model.files)) {
  if (
    !Array.isArray(entry) ||
    entry.length !== 2 ||
    !Number.isSafeInteger(entry[0]) ||
    entry[0] <= 0 ||
    typeof entry[1] !== "string" ||
    !/^[0-9a-f]{64}$/.test(entry[1])
  ) {
    throw new Error(`SenseVoice model file lock mismatch: ${filename}`);
  }
}
if (
  !Array.isArray(senseVoiceLock.model.smoke) ||
  senseVoiceLock.model.smoke.length !== 3 ||
  senseVoiceLock.model.smoke[0] !== "test_wavs/zh.wav" ||
  !Number.isSafeInteger(senseVoiceLock.model.smoke[1]) ||
  senseVoiceLock.model.smoke[1] <= 0 ||
  !/^[0-9a-f]{64}$/.test(senseVoiceLock.model.smoke[2])
) {
  throw new Error("SenseVoice smoke artifact lock mismatch");
}

const senseVoiceNotice = readFileSync(join(senseVoiceRoot, "SENSEVOICE-NOTICE.md"));
if (
  createHash("sha256").update(senseVoiceNotice).digest("hex") !==
  "1a9edf11074749674b0676d9bbe058a6acbc33d219ffd760ef1ecab455ba988c"
) {
  throw new Error("SenseVoice third-party notice integrity mismatch");
}

console.log("Realtime bundle resource contract verified");
