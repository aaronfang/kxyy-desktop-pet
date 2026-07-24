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
]);

for (const [source, target] of expectedMappings) {
  if (resources[source] !== target) {
    throw new Error(`missing fixed VAD resource mapping: ${source}`);
  }
  const sourcePath = resolve(TAURI_DIR, source);
  const stat = lstatSync(sourcePath);
  if (source.endsWith("silero-v6.2.1") ? !stat.isDirectory() : !stat.isFile()) {
    throw new Error(`VAD resource mapping must resolve to the expected type: ${source}`);
  }
}

const forbiddenBundlePath =
  /(^|\/)(?:persona-assets\.js|\.persona-assets\.js\.bak|settings\.json|\.env(?:\.[^/]*)?|\.venv[^/]*|__pycache__|[^/]*\.whl|\.vad-staging-[^/]*|downloads?|\.ready)(?:\/|$)/i;

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

console.log("VAD bundle resource contract verified");
