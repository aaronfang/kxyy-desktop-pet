import test from "node:test";
import assert from "node:assert/strict";
import { ingestMemorySource, normalizeMemorySourceCard, sourceCardIdempotencyKey } from "../src/ai/memory-source-card.js";
import { createMemoryChunks } from "../src/ai/memory-chunks.js";

test("source cards enforce type, scope, consent and bounded provenance", () => {
  const card = normalizeMemorySourceCard({ sourceId: "chat-1", sourceType: "text_chat", scope: "card-a/user-a", observedAt: 10, consent: "allowed", excerpt: "x".repeat(500), eventIds: ["e", "e"] });
  assert.equal(card.excerpt.length, 320);
  assert.deepEqual(card.eventIds, ["e"]);
  assert.equal(sourceCardIdempotencyKey(card), "card-a/user-a:text_chat:chat-1");
});

test("partial, private and unconfirmed sources fail closed", () => {
  assert.equal(normalizeMemorySourceCard({ sourceId: "asr", sourceType: "realtime_completed", scope: "s", observedAt: 1, consent: "allowed", completed: false }), null);
  assert.equal(normalizeMemorySourceCard({ sourceId: "x", sourceType: "text_chat", scope: "s", observedAt: 1, consent: "private_session" }), null);
  assert.equal(normalizeMemorySourceCard({ sourceId: "x", sourceType: "unknown", scope: "s", observedAt: 1, consent: "allowed" }), null);
});

test("realtime cards require completed playback and fresh cards require explicit persistence boundary", () => {
  assert.ok(normalizeMemorySourceCard({ sourceId: "rt", sourceType: "realtime_completed", scope: "s", observedAt: 1, consent: "explicit", completed: true }));
  assert.equal(normalizeMemorySourceCard({ sourceId: "topic", sourceType: "fresh_topic", scope: "s", observedAt: 1, consent: "allowed" }), null);
});

test("ingest adapter composes one sanitized source write with deterministic chunks", async () => {
  const calls = [];
  const result = await ingestMemorySource({ invoke: async (...args) => { calls.push(args); return { ok: true, duplicate: false }; }, card: { sourceId: "chat", sourceType: "text_chat", scope: "card/user", observedAt: 1, consent: "allowed" }, text: "一段可追溯内容", split: (text, card) => createMemoryChunks(text, card) });
  assert.deepEqual(result, { ok: true, duplicate: false, chunkCount: 1 });
  assert.equal(calls[0][0], "memory_source_card_upsert");
  assert.equal(calls[0][1].request.chunks[0].text, "一段可追溯内容");
});
