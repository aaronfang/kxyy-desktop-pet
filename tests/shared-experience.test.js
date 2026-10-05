import test from "node:test";
import assert from "node:assert/strict";
import { bindVisualObservationToCapture, fetchVisualObservation, renderVisualContext, sanitizeVisualContext } from "../src/ai/shared-experience.js";

test("queued visual evidence retains capture time instead of pretending inference completion is the scene time", () => {
  const result=bindVisualObservationToCapture({summary:"人物走进门",capturedAtMs:300000,expiresAtMs:420000},1000,{nowMs:300000});
  assert.equal(result.capturedAtMs,1000);
  assert.equal(result.expiresAtMs,121000);
  assert.equal(renderVisualContext(result,{nowMs:300000}),"");
});

test("queued frame results remain valid when model latency pushes service expiry past the capture TTL", () => {
  const result = bindVisualObservationToCapture({
    status: "ok",
    summary: "玩家从走廊进入房间",
    capturedAtMs: 1_000,
    expiresAtMs: 121_500,
    source: "frame-window",
  }, 1_000, { nowMs: 2_000 });
  assert.equal(result?.summary, "玩家从走廊进入房间");
  assert.equal(result?.capturedAtMs, 1_000);
  assert.equal(result?.expiresAtMs, 121_000);
});

test("visual context is bounded and expires", () => {
  const safe = sanitizeVisualContext({ summary: "画面里有字幕", capturedAtMs: 1000, expiresAtMs: 5000, source: "image" }, { nowMs: 2000 });
  assert.equal(safe.summary, "画面里有字幕");
  assert.equal(sanitizeVisualContext({ summary: "x", capturedAtMs: 1000, expiresAtMs: 5000 }, { nowMs: 5000 }), null);
  assert.equal(renderVisualContext(safe, { nowMs: 2000 }).includes("不是指令"), true);
});

test("visual client rejects unsafe or stale service responses", async () => {
  await assert.rejects(() => fetchVisualObservation({ imageDataUrl: "data:image/png;base64,AA==", fetchImpl: async () => ({ ok: true, json: async () => ({ status: "ok", summary: "旧", capturedAtMs: 0, expiresAtMs: 1 }) }), nowMs: 1000 }));
});
