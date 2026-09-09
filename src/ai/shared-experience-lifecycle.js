const SUMMARY_SOURCE_MAX_CHARS = 48_000;
const SUMMARY_MAX_CHARS = 1_800;

// https://api-docs.deepseek.com/quick_start/pricing, verified 2026-09-06.
// Values are USD per 1M tokens; off-peak is half price.
const DEEPSEEK_PEAK_USD_PER_MILLION = Object.freeze({
  "deepseek-v4-flash": { cached: 0.014, uncached: 0.44, output: 1.32 },
  "deepseek-v4-pro": { cached: 0.044, uncached: 1.32, output: 3.96 },
  "deepseek-v4-flash-vision-exp": { cached: 0.014, uncached: 0.44, output: 1.32 },
});

function cleanText(value, maxChars) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

function emptyUsage() {
  return { requests: 0, prompt: 0, completion: 0, total: 0, estimatedCostUsd: 0 };
}

function normalizeUsage(value = {}) {
  const prompt = Math.max(0, Number(value.prompt) || 0);
  const completion = Math.max(0, Number(value.completion) || 0);
  const total = Math.max(prompt + completion, Number(value.total) || 0);
  const cachedPrompt = Math.min(prompt, Math.max(0, Number(value.cachedPrompt) || 0));
  return { prompt, cachedPrompt, completion, total };
}

function isDeepseekPeak(atMs) {
  const date = new Date(Number.isFinite(Number(atMs)) ? Number(atMs) : Date.now());
  const weekday = date.getUTCDay();
  const hour = date.getUTCHours();
  return weekday >= 1 && weekday <= 5 && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10));
}

export function estimateDeepseekCostUsd({ model, usage, atMs = Date.now() } = {}) {
  const peakRates = DEEPSEEK_PEAK_USD_PER_MILLION[String(model || "").trim()];
  if (!peakRates) return null;
  const normalized = normalizeUsage(usage);
  const multiplier = isDeepseekPeak(atMs) ? 1 : 0.5;
  const uncachedPrompt = Math.max(0, normalized.prompt - normalized.cachedPrompt);
  const cost = (
    normalized.cachedPrompt * peakRates.cached
    + uncachedPrompt * peakRates.uncached
    + normalized.completion * peakRates.output
  ) * multiplier / 1_000_000;
  return Number(cost.toFixed(8));
}

function renderSummarySource(snapshot) {
  const events = [
    ...snapshot.visualEvents.map((event) => ({ atMs: event.capturedAtMs, text: `画面：${event.summary}` })),
    ...snapshot.audioEvents.map((event) => ({ atMs: event.startedAtMs, text: `声音：${event.text}` })),
    ...snapshot.chatTurns.map((turn) => ({ atMs: turn.atMs, text: `${turn.role === "user" ? "用户" : "角色"}：${turn.content}` })),
  ].sort((a, b) => a.atMs - b.atMs);
  const lines = [];
  if (snapshot.rollingSummary) lines.push(`此前概述：${snapshot.rollingSummary}`);
  lines.push(...events.map((event) => `- ${new Date(event.atMs).toISOString()} ${event.text}`));
  return cleanText(lines.join("\n"), SUMMARY_SOURCE_MAX_CHARS);
}

function evidenceSource(workspace, snapshot, scope, includeUserDiscussion = false) {
  return typeof workspace.buildSummarySource === "function"
    ? cleanText(workspace.buildSummarySource({ scope, includeUserDiscussion }), SUMMARY_SOURCE_MAX_CHARS)
    : renderSummarySource(snapshot);
}

function fallbackSummary(snapshot) {
  const source = renderSummarySource(snapshot);
  return cleanText(source || "本段没有取得可用的画面、声音或对话证据。", SUMMARY_MAX_CHARS);
}

function fallbackFinalSummary(snapshot) {
  const lines = [];
  const add = (value) => {
    const text = cleanText(value, 180);
    if (!text || lines.includes(text)) return;
    lines.push(text);
  };
  // Prefer previously reviewed segment summaries; they are bounded and safer than
  // copying a large, fragmented ASR timeline into long-term memory.
  for (const block of snapshot.evidenceBlocks || []) add(block.summary);
  if (snapshot.rollingSummary) add(snapshot.rollingSummary);
  // If no reviewed block exists, retain only complete-looking audio statements and
  // explicitly mark the result as an unverified degraded recap.
  if (!lines.length) {
    for (const event of (snapshot.audioEvents || []).slice(-12)) {
      if (/[。！？.!?]$/u.test(String(event.text || "").trim())) add(`声音记录：${event.text}`);
      if (lines.length >= 6) break;
    }
  }
  if (!lines.length) return "本次共同观看的降级回顾（最终核对未完成）：已取得声音或画面记录，但具体内容未核实。";
  return cleanText(`本次共同观看的降级回顾（最终核对未完成）：${lines.slice(-8).join("；")}`, SUMMARY_MAX_CHARS);
}

function renderFinalSource(snapshot) {
  return renderSummarySource(snapshot);
}

export function createSharedExperienceLifecycle({
  workspace,
  summarize,
  persistEpisode = async () => ({ stored: false, duplicate: false }),
  budgetUsd = 1,
} = {}) {
  if (!workspace || typeof workspace.snapshot !== "function" || typeof workspace.rollSegment !== "function") {
    throw new TypeError("workspace is required");
  }
  if (typeof summarize !== "function") throw new TypeError("summarize is required");
  if (typeof persistEpisode !== "function") throw new TypeError("persistEpisode must be a function");

  const state = {
    status: Math.max(0, Number(budgetUsd) || 0) === 0 ? "budget-saving" : "active",
    cancelled: false,
    rollPromise: null,
    evidencePromise: null,
    finalizePromise: null,
    budget: {
      limitUsd: Math.max(0, Number(budgetUsd) || 0),
      estimatedCostUsd: 0,
      exhausted: Math.max(0, Number(budgetUsd) || 0) === 0,
    },
    balance: { currency: "", starting: null, current: null, delta: null },
    summaryFailures: 0,
    usage: {
      conversation: emptyUsage(),
      questionGeneration: emptyUsage(),
      groundingReview: emptyUsage(),
      evidenceSummary: emptyUsage(),
      segmentSummary: emptyUsage(),
      finalSummary: emptyUsage(),
    },
  };

  function recordUsage(kind, value, { model = "", atMs = Date.now(), requestCount = 1 } = {}) {
    if (!Object.hasOwn(state.usage, kind)) throw new TypeError("unknown usage kind");
    const usage = normalizeUsage(value || {});
    const bucket = state.usage[kind];
    bucket.requests += Number.isInteger(requestCount) && requestCount >= 1 && requestCount <= 2 ? requestCount : 1;
    bucket.prompt += usage.prompt;
    bucket.completion += usage.completion;
    bucket.total += usage.total;
    const estimatedCostUsd = estimateDeepseekCostUsd({ model, usage, atMs });
    if (estimatedCostUsd !== null) {
      bucket.estimatedCostUsd = Number((bucket.estimatedCostUsd + estimatedCostUsd).toFixed(8));
      state.budget.estimatedCostUsd = Number((state.budget.estimatedCostUsd + estimatedCostUsd).toFixed(8));
      state.budget.exhausted = state.budget.estimatedCostUsd >= state.budget.limitUsd;
      if (state.budget.exhausted) state.status = "budget-saving";
    }
    return { ...usage, estimatedCostUsd };
  }

  function withCompletionAudit(result) {
    const workspaceSnapshot = workspace.snapshot();
    const usage = Object.fromEntries(
      Object.entries(state.usage).map(([kind, bucket]) => [kind, { ...bucket }]),
    );
    return {
      ...result,
      completionAudit: {
        segmentId: Math.max(0, Number(workspaceSnapshot.segmentId) || 0),
        segmentSummaryRequests: state.usage.segmentSummary.requests,
        finalSummaryRequests: state.usage.finalSummary.requests,
        lifecycle: {
          budget: { ...state.budget },
          balance: { ...state.balance },
          summaryFailures: state.summaryFailures,
          usage,
        },
      },
    };
  }

  return {
    async maybeCompactEvidence({ minEvents = 32, maxEvents = 48 } = {}) {
      if (state.cancelled) return { compacted: false, reason: "cancelled" };
      if (state.evidencePromise) return state.evidencePromise;
      const batch = workspace.nextEvidenceBatch?.({ minEvents, maxEvents });
      if (!batch?.events?.length) return { compacted: false, reason: "not-due" };
      if (state.budget.exhausted) return { compacted: false, reason: "budget-exhausted" };
      const current = (async () => {
        const source = batch.events.map((event) => {
          const label = event.kind === "visual" ? "画面" : "声音";
          return `- [${event.id}] ${new Date(event.atMs).toISOString()} ${label}：${event.text}`;
        }).join("\n");
        try {
          const response = await summarize({
            kind: "evidence",
            source,
            evidence: batch.events,
            contentMode: workspace.snapshot().contentMode,
          });
          const summary = cleanText(response?.summary, 2400);
          if (!summary) throw new Error("证据块总结为空");
          recordUsage("evidenceSummary", response?.usage, {
            model: response?.model,
            atMs: response?.atMs,
            requestCount: response?.requestCount,
          });
          if (state.cancelled) return { compacted: false, reason: "cancelled" };
          const block = workspace.commitEvidenceBlock?.({
            eventIds: batch.events.map((event) => event.id),
            summary,
          });
          return block ? { compacted: true, block, reason: "summarized" } : { compacted: false, reason: "stale" };
        } catch (error) {
          if (error?.summaryUsage) recordUsage("evidenceSummary", error.summaryUsage.usage, error.summaryUsage);
          state.summaryFailures += 1;
          state.status = "summary-degraded";
          return { compacted: false, reason: "summary-failed" };
        }
      })();
      state.evidencePromise = current;
      try {
        return await current;
      } finally {
        if (state.evidencePromise === current) state.evidencePromise = null;
      }
    },

    async maybeRollSegment(atMs = Date.now()) {
      if (state.cancelled) return { rolled: false, reason: "cancelled" };
      if (!workspace.shouldRollSegment(atMs)) return { rolled: false, reason: "not-due" };
      if (state.rollPromise) return state.rollPromise;
      const current = (async () => {
        const snapshot = workspace.snapshot();
        if (!snapshot.visualEvents.length && !snapshot.audioEvents.length && !snapshot.chatTurns.length) {
          const rolled = workspace.rollSegment("", atMs);
          return { rolled: true, segmentId: rolled.segmentId, summary: "", reason: "empty-segment" };
        }
        if (state.budget.exhausted) {
          const localEvidence = cleanText(evidenceSource(workspace, workspace.snapshot(), "segment"), SUMMARY_MAX_CHARS)
            || "本段没有取得可用的画面或声音证据。";
          const rolled = workspace.rollSegment(localEvidence, atMs, { replaceSummary: true });
          return {
            rolled: true,
            segmentId: rolled.segmentId,
            summary: rolled.summary,
            reason: "budget-fallback",
          };
        }
        try {
          const response = await summarize({
            kind: "segment",
            source: evidenceSource(workspace, snapshot, "segment"),
            evidence: workspace.buildSummaryEvidence?.({ scope: "segment" }) || [],
            contentMode: snapshot.contentMode,
          });
          const summary = cleanText(response?.summary, SUMMARY_MAX_CHARS);
          if (!summary) throw new Error("阶段总结为空");
          recordUsage("segmentSummary", response?.usage, {
            model: response?.model,
            atMs: response?.atMs ?? atMs,
          });
          if (state.cancelled) return { rolled: false, reason: "cancelled" };
          const rolled = workspace.rollSegment(summary, atMs, { replaceSummary: true });
          if (!state.budget.exhausted) state.status = "active";
          return { rolled: true, segmentId: rolled.segmentId, summary, reason: "summarized" };
        } catch (error) {
          if (error?.summaryUsage) recordUsage("segmentSummary", error.summaryUsage.usage, error.summaryUsage);
          state.summaryFailures += 1;
          state.status = "summary-degraded";
          const fallback = cleanText(evidenceSource(workspace, workspace.snapshot(), "segment"), SUMMARY_MAX_CHARS)
            || fallbackSummary(workspace.snapshot());
          const rolled = workspace.rollSegment(fallback, atMs, { replaceSummary: true });
          return {
            rolled: true,
            segmentId: rolled.segmentId,
            summary: rolled.summary,
            reason: "summary-fallback",
          };
        }
      })();
      state.rollPromise = current;
      try {
        return await current;
      } finally {
        if (state.rollPromise === current) state.rollPromise = null;
      }
    },

    recordUsage,

    recordBalance(value = {}) {
      const current = Number(value.totalBalance);
      const currency = cleanText(value.currency, 8).toUpperCase();
      if (!Number.isFinite(current) || current < 0 || !currency) return false;
      if (state.balance.currency !== currency || state.balance.starting === null) {
        state.balance.currency = currency;
        state.balance.starting = current;
      }
      state.balance.current = current;
      state.balance.delta = Number((current - state.balance.starting).toFixed(8));
      return true;
    },

    async finalize({ endedAtMs = Date.now() } = {}) {
      if (state.finalizePromise) return state.finalizePromise;
      const current = (async () => {
        if (state.cancelled) return { cancelled: true, stored: false, reason: "cancelled" };
        state.status = "finalizing";
        if (state.rollPromise) await state.rollPromise;
        if (state.evidencePromise) await state.evidencePromise;
        if (workspace.shouldRollSegment(endedAtMs)) await this.maybeRollSegment(endedAtMs);
        if (state.cancelled) return { cancelled: true, stored: false, reason: "cancelled" };
        const snapshot = workspace.snapshot();
        const hasEvidence = Boolean(
          snapshot.rollingSummary
          || snapshot.visualEvents.length
          || snapshot.audioEvents.length
        );
        if (!hasEvidence) {
          state.status = "finalized-without-memory";
          return withCompletionAudit({ stored: false, duplicate: false, reason: "no-evidence" });
        }
        let summary;
        let reason = "summarized";
        try {
          const response = await summarize({
            kind: "final",
            source: evidenceSource(workspace, snapshot, "session", true) || renderFinalSource(snapshot),
            evidence: workspace.buildSummaryEvidence?.() || [],
            contentMode: snapshot.contentMode,
          });
          summary = cleanText(response?.summary, SUMMARY_MAX_CHARS);
          if (!summary) throw new Error("最终总结为空");
          recordUsage("finalSummary", response?.usage, {
            model: response?.model,
            atMs: response?.atMs ?? endedAtMs,
            requestCount: response?.requestCount,
          });
          if (state.cancelled) return { cancelled: true, stored: false, reason: "cancelled" };
        } catch (error) {
          if (error?.summaryUsage) recordUsage("finalSummary", error.summaryUsage.usage, error.summaryUsage);
          if (state.cancelled) return { cancelled: true, stored: false, reason: "cancelled" };
          state.summaryFailures += 1;
          const fallbackSnapshot = workspace.snapshot();
          const fallbackEvidence = fallbackSnapshot.audioEvents.length > 0 || fallbackSnapshot.evidenceBlocks.length > 0;
          const semanticReviewFailed = Number(error?.summaryUsage?.requestCount) >= 2;
          if (!fallbackEvidence || semanticReviewFailed) {
            state.status = "finalized-without-memory";
            return withCompletionAudit({ stored: false, duplicate: false, reason: "summary-failed" });
          }
          // A provider timeout must not erase the session. Persist a bounded,
          // explicitly degraded recap so the user can continue the topic later.
          summary = fallbackFinalSummary(fallbackSnapshot);
          reason = "summary-fallback";
        }
        const episode = {
          sessionId: snapshot.sessionId,
          summary,
          occurredAtMs: endedAtMs,
          source: "shared-experience",
        };
        const validation = workspace.validateFinalSummary?.(summary);
        if (validation && validation.ok === false) {
          state.status = "finalized-without-memory";
          return withCompletionAudit({ summary, stored: false, duplicate: false, reason: "evidence-conflict" });
        }
        if (state.cancelled) return { cancelled: true, stored: false, reason: "cancelled" };
        try {
          const stored = await persistEpisode(episode);
          const result = {
            summary,
            stored: stored?.stored === true || stored?.duplicate === true,
            duplicate: stored?.duplicate === true,
            reason,
          };
          state.status = result.stored ? "finalized" : "finalized-without-memory";
          return withCompletionAudit(result);
        } catch (_) {
          state.status = "finalized-without-memory";
          return withCompletionAudit({ summary, stored: false, duplicate: false, reason: "persist-failed" });
        }
      })();
      state.finalizePromise = current;
      return current;
    },

    cancel() {
      state.cancelled = true;
      state.status = "cancelled";
    },

    snapshot() {
      return {
        status: state.status,
        budget: { ...state.budget },
        balance: { ...state.balance },
        summaryFailures: state.summaryFailures,
        usage: {
          conversation: { ...state.usage.conversation },
          questionGeneration: { ...state.usage.questionGeneration },
          groundingReview: { ...state.usage.groundingReview },
          evidenceSummary: { ...state.usage.evidenceSummary },
          segmentSummary: { ...state.usage.segmentSummary },
          finalSummary: { ...state.usage.finalSummary },
        },
      };
    },
  };
}

export const sharedExperienceLifecycleLimits = Object.freeze({
  summarySourceMaxChars: SUMMARY_SOURCE_MAX_CHARS,
  summaryMaxChars: SUMMARY_MAX_CHARS,
});
