const DEFAULT_DURATION_MS = 30 * 60 * 1000;
const MAX_DURATION_MS = 2 * 60 * 60 * 1000;
const MAX_TURNS = 200;
const MAX_PROMPT_CHARS = 500;

export function createSharedExperienceRuntimeReceipts() {
  const state = Object.fromEntries(["vision", "asr", "text"].map((kind) => [kind, {
    provider: null, successfulResponses: 0, failedResponses: 0, completedResponses: 0,
  }]));
  const record = (kind, provider, valid, completed = valid) => {
    const entry = state[kind];
    if (!valid || !completed) { entry.failedResponses += 1; return; }
    const allowed = { vision: ["mage-vl"], asr: ["sensevoice", "whisper"], text: ["deepseek", "ollama", "local"] };
    const normalized = String(provider || "").toLowerCase();
    const observed = allowed[kind].includes(normalized) ? normalized : "mixed-or-unknown";
    entry.provider = entry.provider === null || entry.provider === observed ? observed : "mixed-or-unknown";
    entry.successfulResponses += 1;
    entry.completedResponses += 1;
  };
  return {
    recordVision(value) {
      record("vision", value?.provider, value?.status === "ok" && !!value?.summary,
        typeof value?.summary === "string" && value.summary.trim().length > 0);
    },
    recordAsr(value) {
      const active = value?.asrRuntime?.active;
      const provider = active === "sensevoice-sherpa-onnx" ? "sensevoice"
        : ["whisper-mlx", "whisper-openai"].includes(active) ? "whisper" : active;
      // Silence is a valid inference result, but only a response explicitly
      // marked complete proves that the selected ASR backend actually ran.
      record("asr", provider, value?.status === "ok" && typeof value?.text === "string",
        value?.status === "ok" && value?.asrRuntime?.status === "active");
    },
    recordText(value) {
      record("text", value?.provider, !!value?.provider,
        value?.completed === true && Number(value?.responseChars) > 0);
    },
    recordFailure(kind) { if (state[kind]) state[kind].failedResponses += 1; },
    snapshot() { return Object.fromEntries(Object.entries(state).map(([kind, value]) => [kind, { ...value }])); },
  };
}

function boundedNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function safeText(value, maxChars) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

export function buildAcceptanceEvidenceFallbackQuestion(snapshot = {}) {
  const events = Array.isArray(snapshot?.workspace?.evidenceJournal)
    ? snapshot.workspace.evidenceJournal
    : [];
  const latest = events.findLast((event) => {
    if (!["visual", "audio"].includes(event?.kind)) return false;
    const text = safeText(event?.text, MAX_PROMPT_CHARS);
    return text.length >= 4 && /[\p{L}\p{N}]/u.test(text);
  });
  if (!latest?.id) return {};
  return {
    prompt: latest.kind === "audio" ? "刚才这段解说主要在说什么？" : "画面里现在最明显的内容是什么？",
    topic: "当前内容",
    anchorEventIds: [safeText(latest.id, 80)],
    maturity: "shallow",
  };
}

export function buildSharedExperienceCleanupReceipt({ active = false, workspace = null, spool = null } = {}) {
  let pending = 0;
  try {
    const value = Number(spool?.snapshot?.().pending);
    if (Number.isFinite(value)) pending = Math.max(0, Math.floor(value));
  } catch {
    pending = 0;
  }
  const receipt = {
    captureStopped: active !== true,
    workspaceReleased: workspace == null,
    spoolReleased: spool == null,
    pending,
  };
  return {
    ...receipt,
    complete: receipt.captureStopped && receipt.workspaceReleased && receipt.spoolReleased && receipt.pending === 0,
  };
}

export function normalizeSharedExperienceAcceptancePlan(raw = {}) {
  const durationMs = boundedNumber(raw.durationMs, DEFAULT_DURATION_MS, 1, MAX_DURATION_MS);
  const turns = (Array.isArray(raw.turns) ? raw.turns : [])
    .slice(0, MAX_TURNS)
    .map((turn) => {
      const category = safeText(turn?.category, 40);
      return {
        atMs: boundedNumber(turn?.atMs, 0, 0, durationMs),
        prompt: safeText(turn?.prompt, MAX_PROMPT_CHARS),
        ...(turn?.dynamic === true ? { dynamic: true } : {}),
        ...(category ? { category } : {}),
      };
    })
    .filter((turn) => turn.prompt || turn.dynamic)
    .sort((a, b) => a.atMs - b.atMs);
  return { durationMs, turns };
}

export async function runSharedExperienceAcceptancePlan({
  plan: rawPlan,
  sendPrompt,
  finish = async () => null,
  snapshot = () => null,
  nowMs = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onTurn = () => {},
  questionForTurn = null,
  waitForStart = async () => {},
} = {}) {
  if (typeof sendPrompt !== "function") throw new TypeError("sendPrompt is required");
  const plan = normalizeSharedExperienceAcceptancePlan(rawPlan);
  if (typeof waitForStart !== "function") throw new TypeError("waitForStart must be a function");
  await waitForStart();
  const startedAtMs = nowMs();
  const deadlineAtMs = startedAtMs + plan.durationMs;
  const records = [];
  const skippedTurnDetails = [];

  for (let index = 0; index < plan.turns.length; index += 1) {
    if (nowMs() >= deadlineAtMs) break;
    const turn = plan.turns[index];
    const targetAtMs = startedAtMs + turn.atMs;
    const waitMs = Math.min(targetAtMs, deadlineAtMs) - nowMs();
    if (waitMs > 0) await sleep(waitMs);
    if (nowMs() >= deadlineAtMs) break;
    const turnStartedAtMs = nowMs();
    let question = { prompt: turn.prompt };
    if (turn.dynamic) {
      if (typeof questionForTurn !== "function") throw new TypeError("questionForTurn is required for dynamic turns");
      question = await questionForTurn({
        index,
        elapsedMs: turnStartedAtMs - startedAtMs,
        category: turn.category || "",
        snapshot: snapshot(),
      }) || {};
    }
    if (nowMs() >= deadlineAtMs) break;
    const prompt = safeText(question.prompt, MAX_PROMPT_CHARS);
    const anchorEventIds = (Array.isArray(question.anchorEventIds) ? question.anchorEventIds : [])
      .map((id) => safeText(id, 80)).filter(Boolean).slice(0, 8);
    if (turn.dynamic && (!prompt || !anchorEventIds.length)) {
      skippedTurnDetails.push({
        index: index + 1,
        scheduledAtMs: turn.atMs,
        ...(turn.category ? { category: turn.category } : {}),
        reason: anchorEventIds.length ? "empty-dynamic-question" : "no-evidence-anchor",
      });
      continue;
    }
    const record = {
      index: index + 1,
      scheduledAtMs: turn.atMs,
      startedAtMs: turnStartedAtMs - startedAtMs,
      scheduleLagMs: Math.max(0, turnStartedAtMs - targetAtMs),
      prompt,
      ...(question.topic ? { questionTopic: safeText(question.topic, 24) } : {}),
      questionGenerationMs: Math.max(0, nowMs() - turnStartedAtMs),
      anchorEventIds,
      ...(safeText(question.maturity, 24) ? { maturity: safeText(question.maturity, 24) } : {}),
      ...(turn.category ? { category: turn.category } : {}),
      ok: false,
      assistant: "",
      responseMs: 0,
    };
    try {
      if (!record.prompt) throw new Error("动态问题为空");
      const result = await sendPrompt(record.prompt, index, question);
      record.ok = true;
      record.assistant = safeText(result?.assistant, 4000);
      if (result?.usage !== undefined) record.usage = result.usage;
      if (result?.workspace !== undefined) record.workspace = result.workspace;
      if (result?.ttsReceipt !== undefined) record.ttsReceipt = result.ttsReceipt;
      if (result?.groundingAudit !== undefined) record.groundingAudit = result.groundingAudit;
    } catch (error) {
      record.error = safeText(error?.message || error, 500) || "unknown error";
    }
    record.responseMs = Math.max(0, nowMs() - turnStartedAtMs);
    records.push(record);
    await onTurn({ ...record });
  }

  const remainingMs = deadlineAtMs - nowMs();
  if (remainingMs > 0) await sleep(remainingMs);
  const beforeFinalize = snapshot();
  let finalize = null;
  let finalizeError = "";
  try {
    finalize = await finish();
  } catch (error) {
    finalizeError = safeText(error?.message || error, 500) || "unknown error";
  }
  const endedAtMs = nowMs();
  return {
    schemaVersion: 1,
    startedAtMs,
    endedAtMs,
    durationMs: endedAtMs - startedAtMs,
    plannedDurationMs: plan.durationMs,
    plannedTurns: plan.turns.length,
    completedTurns: records.length,
    skippedTurns: Math.max(0, plan.turns.length - records.length),
    successfulTurns: records.filter((turn) => turn.ok).length,
    failedTurns: records.filter((turn) => !turn.ok).length,
    stopReason: "duration-deadline",
    turns: records,
    skippedTurnDetails,
    beforeFinalize,
    finalize,
    ...(finalizeError ? { finalizeError } : {}),
  };
}

export const sharedExperienceAcceptanceLimits = Object.freeze({
  durationMs: DEFAULT_DURATION_MS,
  maxDurationMs: MAX_DURATION_MS,
  maxTurns: MAX_TURNS,
  maxPromptChars: MAX_PROMPT_CHARS,
});
