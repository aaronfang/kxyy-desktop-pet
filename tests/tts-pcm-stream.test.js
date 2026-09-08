import test from "node:test";
import assert from "node:assert/strict";

import { consumePcm16Stream } from "../src/ai/tts-pcm-stream.js";

test("PCM stream starts playback before the response finishes", async () => {
  let releaseSecond;
  const secondReady = new Promise((resolve) => { releaseSecond = resolve; });
  let closed = false;
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 0, 2, 0]));
      void secondReady.then(() => {
        controller.enqueue(new Uint8Array([3, 0, 4, 0]));
        closed = true;
        controller.close();
      });
    },
  }));
  const scheduled = [];
  let startedWhileOpen = false;
  const done = consumePcm16Stream(response, {
    startupSamples: 2,
    schedule(samples) {
      scheduled.push([...samples]);
      startedWhileOpen ||= !closed;
      return Promise.resolve();
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(startedWhileOpen, true);
  assert.deepEqual(scheduled, [[1, 2]]);
  releaseSecond();
  await done;
  assert.deepEqual(scheduled, [[1, 2], [3, 4]]);
});

test("PCM stream preserves a sample split across network chunks", async () => {
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([0x34]));
      controller.enqueue(new Uint8Array([0x12, 0xfe, 0xff]));
      controller.close();
    },
  }));
  const samples = [];
  await consumePcm16Stream(response, {
    startupSamples: 1,
    schedule(chunk) { samples.push(...chunk); },
  });
  assert.deepEqual(samples, [0x1234, -2]);
});

test("PCM stream rejects an odd trailing byte instead of corrupting audio", async () => {
  const response = new Response(new Uint8Array([1, 0, 2]));
  await assert.rejects(
    consumePcm16Stream(response, { startupSamples: 1, schedule() {} }),
    /长度不是偶数/,
  );
});

test("PCM stream applies backpressure when scheduled audio reaches the ahead limit", async () => {
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 0, 2, 0]));
      controller.enqueue(new Uint8Array([3, 0, 4, 0]));
      controller.enqueue(new Uint8Array([5, 0, 6, 0]));
      controller.close();
    },
  }));
  const releases = [];
  const scheduled = [];
  const done = consumePcm16Stream(response, {
    startupSamples: 2,
    maxScheduledSamples: 2,
    schedule(samples) {
      scheduled.push([...samples]);
      return new Promise((resolve) => releases.push(resolve));
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(scheduled, [[1, 2]]);
  releases.shift()();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(scheduled, [[1, 2], [3, 4]]);
  releases.shift()();
  await new Promise((resolve) => setTimeout(resolve, 0));
  releases.shift()();
  await done;
  assert.deepEqual(scheduled, [[1, 2], [3, 4], [5, 6]]);
});

test("aborting PCM consumption cancels a pending response reader", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 0, 2, 0]));
    },
    cancel() {
      cancelled = true;
    },
  }));
  const controller = new AbortController();
  const done = consumePcm16Stream(response, {
    startupSamples: 2,
    signal: controller.signal,
    schedule() { return Promise.resolve(); },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort();

  const outcome = await Promise.race([
    done.then(() => "resolved", (error) => error?.name || "rejected"),
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 100)),
  ]);
  assert.equal(outcome, "AbortError");
  assert.equal(cancelled, true);
});

test("PCM stream reports when provider delivery cannot sustain playback", async () => {
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 0, 2, 0]));
      controller.enqueue(new Uint8Array([3, 0, 4, 0]));
      controller.close();
    },
  }));
  const times = [0, 0.9];
  const metrics = await consumePcm16Stream(response, {
    startupSamples: 2,
    sampleRate: 10,
    nowSeconds: () => times.shift() ?? 0.9,
    schedule() {},
  });
  assert.deepEqual(metrics, { underrunCount: 1, maxGapMs: 700 });
});
