import test from "node:test";
import assert from "node:assert/strict";
import * as archive from "../src/ai/shared-experience-archive.js";
const scope = { cardId: "card-a", nickname: "小明" };
const snapshot = { sessionId: "shared-1", contentMode: "game-narrated", primer: { title: "星海纪事" },
  evidenceJournal: [{ id: "ev-1", kind: "audio", atMs: 1, text: "解说进入空间站。" }] };

test("retry evidence stays ephemeral, bounded, and scoped", () => {
  const values = new Map();
  const previous = globalThis.localStorage;
  globalThis.localStorage = { setItem: (k,v) => values.set(k,v), removeItem: (k) => values.delete(k) };
  try {
    archive.clearLatestSharedExperienceRaw();
    assert.equal(archive.saveLatestSharedExperienceRaw(snapshot, { scope, archivedAtMs: 1000 }), true);
    assert.equal(values.size, 0, "raw external observations must not be persisted");
    assert.equal(archive.loadLatestSharedExperienceRaw({ scope, nowMs: 1200 }).sessionId, "shared-1");
    assert.equal(archive.loadLatestSharedExperienceRaw({ scope: { ...scope, nickname: "另一位" }, nowMs: 1200 }), null);
    assert.equal(archive.loadLatestSharedExperienceRaw({ scope: { ...scope, cardId: "card-b" }, nowMs: 1200 }), null);
    assert.equal(archive.loadLatestSharedExperienceRaw({ nowMs: 1200 }), null);
    assert.equal(archive.loadLatestSharedExperienceRaw({ scope, nowMs: 1000 + 31 * 60_000 }), null);
    assert.equal(archive.loadLatestSharedExperienceRaw({ scope, nowMs: 1200 }), null, "expiry physically clears the buffer");
  } finally { globalThis.localStorage = previous; archive.clearLatestSharedExperienceRaw(); }
});

test("review failure never replaces existing memory", async () => {
  archive.saveLatestSharedExperienceRaw(snapshot, { scope });
  let writes = 0;
  await assert.rejects(archive.retryLatestSharedExperienceSummary({ scope,
    summarize: async () => { throw new Error("review unavailable"); },
    persist: async () => { writes++; }, isCurrent: () => true,
  }), /review unavailable/);
  assert.equal(writes, 0);
  archive.clearLatestSharedExperienceRaw();
});

test("clear, replacement, or identity change invalidates an in-flight retry", async () => {
  for (const kind of ["clear", "replace", "identity"]) {
    let current = true;
    archive.saveLatestSharedExperienceRaw(snapshot, { scope });
    let writes = 0;
    const result = await archive.retryLatestSharedExperienceSummary({ scope,
      summarize: async () => { if (kind === "identity") current = false;
        else if (kind === "clear") archive.clearLatestSharedExperienceRaw();
        else archive.saveLatestSharedExperienceRaw({ ...snapshot, sessionId: "new" }, { scope });
        return { summary: "核实后的回顾" }; },
      persist: async () => { writes++; return { stored: true }; }, isCurrent: () => current,
    });
    assert.equal(result, null);
    assert.equal(writes, 0);
  }
  archive.clearLatestSharedExperienceRaw();
});

test("reviewed retry persists with captured scope", async () => {
  archive.saveLatestSharedExperienceRaw(snapshot, { scope });
  let written;
  const result = await archive.retryLatestSharedExperienceSummary({ scope,
    summarize: async () => ({ summary: "核实后的回顾" }), isCurrent: () => true,
    persist: async (episode, owner) => { written = { episode, owner }; return { stored: true }; },
  });
  assert.equal(result.stored.stored, true);
  assert.deepEqual(written.owner, scope);
  assert.equal(written.episode.sessionId, snapshot.sessionId);
  archive.clearLatestSharedExperienceRaw();
});
