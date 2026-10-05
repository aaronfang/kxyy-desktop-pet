import test from "node:test";
import assert from "node:assert/strict";
import { createSharedExperienceSpool } from "../src/ai/shared-experience-spool.js";

test("spool keeps capture active while inference is paused and drains in timestamp order", () => {
  const spool = createSharedExperienceSpool({ maxItems: 4 });
  spool.pauseInference();
  spool.push({ kind: "audio", capturedAtMs: 300, payload: "third" });
  spool.push({ kind: "visual", capturedAtMs: 100, payload: "first" });
  spool.push({ kind: "audio", capturedAtMs: 200, payload: "second" });
  assert.deepEqual(spool.drain(), []);
  assert.equal(spool.snapshot().pending, 3);

  spool.resumeInference();
  assert.deepEqual(spool.drain().map((item) => item.payload), ["first", "second", "third"]);
  assert.equal(spool.snapshot().pending, 0);
});

test("spool bounds items and bytes by evicting oldest capture data", () => {
  const spool = createSharedExperienceSpool({ maxItems: 2, maxBytes: 8 });
  spool.push({ kind: "audio", capturedAtMs: 1, payload: "1234" });
  spool.push({ kind: "audio", capturedAtMs: 2, payload: "5678" });
  spool.push({ kind: "audio", capturedAtMs: 3, payload: "ABCD" });
  const snapshot = spool.snapshot();
  assert.deepEqual(spool.drain().map((item) => item.payload), ["5678", "ABCD"]);
  assert.equal(snapshot.dropped, 1);
  assert.deepEqual(snapshot.droppedByKind, { visual: 0, audio: 1, unknown: 0 });
  assert.equal(snapshot.peakPending, 2);
  assert.equal(snapshot.peakBytes, 8);
  assert.equal(snapshot.bytes, 8);
});

test("spool rejects unsupported capture kinds and clear releases all pending data", () => {
  const spool = createSharedExperienceSpool();
  assert.equal(spool.push({ kind: "microphone", capturedAtMs: 1, payload: "x" }), null);
  spool.push({ kind: "audio", capturedAtMs: 1, payload: "x" });
  spool.clear();
  assert.deepEqual(spool.drain(), []);
  assert.equal(spool.snapshot().pending, 0);
});

test("spool drains one kind without removing an earlier item of another kind", () => {
  const spool = createSharedExperienceSpool({ nowMs: () => 1000 });
  spool.push({ kind: "visual", capturedAtMs: 1000, payload: "frame" });
  spool.push({ kind: "audio", capturedAtMs: 1001, payload: "wav" });
  const audio = spool.drainKind("audio");
  assert.equal(audio?.kind, "audio");
  assert.deepEqual(spool.drain().map((item) => item.kind), ["visual"]);
});

test("spool keeps inference paused until every independent pause reason is released", () => {
  const spool = createSharedExperienceSpool();
  spool.pauseInference("typing");
  spool.pauseInference("tts");
  spool.push({ kind: "visual", capturedAtMs: 1, payload: "frame-during-speech" });

  spool.resumeInference("tts");
  assert.deepEqual(spool.drain(), []);
  assert.deepEqual(spool.snapshot().pauseReasons, ["typing"]);

  spool.resumeInference("typing");
  assert.deepEqual(spool.drain().map((item) => item.payload), ["frame-during-speech"]);
  assert.equal(spool.snapshot().inferencePaused, false);
});

test("spool pause reasons are idempotent and use a stable default for legacy callers", () => {
  const spool = createSharedExperienceSpool();
  spool.pauseInference("tts");
  spool.pauseInference("tts");
  spool.pauseInference();
  assert.deepEqual(spool.snapshot().pauseReasons, ["default", "tts"]);

  spool.resumeInference("tts");
  spool.resumeInference("tts");
  assert.equal(spool.snapshot().inferencePaused, true);
  spool.resumeInference();
  assert.equal(spool.snapshot().inferencePaused, false);
});
