import test from "node:test";
import assert from "node:assert/strict";

import { planEvidenceAnchoredQuestion } from "../src/ai/shared-experience-question-planner.js";

test("early questions keep a real evidence anchor but speak like a viewing companion", () => {
  const result = planEvidenceAnchoredQuestion({
    elapsedMs: 20_000,
    turnIndex: 0,
    snapshot: {
      evidenceJournal: [
        { id: "ev-1", kind: "visual", atMs: 10_000, text: "画面中一名黑发男子站在石像前" },
      ],
      evidenceBlocks: [],
    },
  });

  assert.equal(result.maturity, "shallow");
  assert.deepEqual(result.anchorEventIds, ["ev-1"]);
  assert.match(result.prompt, /画面里的人|在做什么|场景/);
  assert.doesNotMatch(result.prompt, /黑发男子站在石像前/);
  assert.doesNotMatch(result.prompt, /刚才(?:解说|声音|画面)|记录为|只说能确认|明确发生/);
  assert.doesNotMatch(result.prompt, /主线|人物动机|幕后/);
});

test("early visual questions do not turn single-frame OCR noise into a plot change", () => {
  const result = planEvidenceAnchoredQuestion({
    elapsedMs: 30_000,
    turnIndex: 0,
    snapshot: {
      contentMode: "narrated",
      evidenceJournal: [
        { id: "ev-8", kind: "visual", text: "字幕显示但10年前世界上传发了一项灾难" },
      ],
      evidenceBlocks: [],
    },
  });

  assert.deepEqual(result.anchorEventIds, ["ev-8"]);
  assert.doesNotMatch(result.prompt, /变化|改成|前后/);
  assert.match(result.prompt, /画面|场景|动作|留意/);
});

test("later questions connect multiple evidence anchors only after evidence matures", () => {
  const evidenceJournal = Array.from({ length: 50 }, (_, index) => ({
    id: `ev-${index + 1}`,
    kind: index % 2 ? "audio" : "visual",
    atMs: index * 3_000,
    text: index === 49 ? "旁白提到主角获得了新的职业" : `观察 ${index + 1}`,
  }));
  const result = planEvidenceAnchoredQuestion({
    elapsedMs: 16 * 60_000,
    turnIndex: 52,
    requestedCategory: "causal",
    snapshot: { evidenceJournal, evidenceBlocks: [{ id: "block-1", summary: "此前确认主角一直没有职业" }] },
  });

  assert.equal(result.maturity, "story");
  assert.ok(result.anchorEventIds.length >= 1);
  assert.match(result.prompt, /前面|处境|目标|变化|转折|关系/);
  assert.doesNotMatch(result.prompt, /旁白提到主角获得了新的职业/);
});

test("mature viewing keeps fresh evidence as the default and makes retrospection occasional", () => {
  const evidenceJournal = Array.from({ length: 64 }, (_, index) => ({
    id: `ev-${index + 1}`,
    kind: index % 2 ? "audio" : "visual",
    atMs: index * 3_000,
    text: index % 2
      ? `解说正在交代第 ${index + 1} 个新事件`
      : `画面出现第 ${index + 1} 个新动作`,
  }));

  const results = Array.from({ length: 8 }, (_, offset) => planEvidenceAnchoredQuestion({
    elapsedMs: 18 * 60_000 + offset * 20_000,
    turnIndex: 54 + offset,
    snapshot: {
      contentMode: "narrated",
      evidenceJournal,
      evidenceBlocks: [{ id: "block-1", summary: "已有阶段证据" }],
    },
  }));
  const fresh = results.filter((result) => result.category === "evidence");
  const retrospective = results.filter((result) => result.category !== "evidence");

  assert.ok(fresh.length >= 6, `expected at least 6 fresh questions, got ${fresh.length}`);
  assert.ok(retrospective.length <= 2, `expected at most 2 retrospective questions, got ${retrospective.length}`);
  for (const result of fresh) {
    assert.deepEqual(result.anchorEventIds, ["ev-64"]);
    assert.doesNotMatch(result.prompt, /前面|变化|转折|到目前为止|因果关系/);
  }
});

test("fresh questions do not reuse an evidence anchor that was already consumed", () => {
  const result = planEvidenceAnchoredQuestion({
    elapsedMs: 18 * 60_000,
    turnIndex: 56,
    usedPrimaryEventIds: ["ev-latest"],
    snapshot: {
      contentMode: "narrated",
      evidenceJournal: [
        { id: "ev-old", kind: "audio", atMs: 10_000, text: "解说交代了此前发生的事情" },
        { id: "ev-latest", kind: "audio", atMs: 20_000, text: "解说正在讲最新发生的事件" },
      ],
      evidenceBlocks: [{ id: "block-1", summary: "已有阶段证据" }],
    },
  });

  assert.equal(result.maturity, "shallow");
  assert.deepEqual(result.anchorEventIds, ["ev-old"]);
});

test("fresh slot waits instead of repeating when no unused evidence is available", () => {
  const result = planEvidenceAnchoredQuestion({
    elapsedMs: 18 * 60_000,
    turnIndex: 56,
    usedPrimaryEventIds: ["ev-only"],
    snapshot: {
      contentMode: "narrated",
      evidenceJournal: [
        { id: "ev-only", kind: "audio", atMs: 20_000, text: "解说正在讲最新发生的事件" },
      ],
      evidenceBlocks: [{ id: "block-1", summary: "已有阶段证据" }],
    },
  });

  assert.equal(result.maturity, "waiting");
  assert.deepEqual(result.anchorEventIds, []);
});

test("fresh questions wait until the evidence timeline has advanced beyond the last discussion", () => {
  const snapshot = {
    contentMode: "narrated",
    evidenceJournal: [
      { id: "ev-previous", kind: "audio", atMs: 100_000, text: "解说正在讲主角与恶魔王交战" },
      { id: "ev-adjacent", kind: "audio", atMs: 112_000, text: "解说继续描述双方交手的过程" },
    ],
    evidenceBlocks: [{ id: "block-1", summary: "此前剧情" }],
  };

  const waiting = planEvidenceAnchoredQuestion({
    elapsedMs: 18 * 60_000,
    turnIndex: 56,
    lastPrimaryEvidenceAtMs: 100_000,
    snapshot,
  });
  assert.equal(waiting.maturity, "waiting");
  assert.deepEqual(waiting.anchorEventIds, []);

  snapshot.evidenceJournal.push({
    id: "ev-advanced",
    kind: "audio",
    atMs: 131_000,
    text: "解说转到主角返回城市救治家人",
  });
  const advanced = planEvidenceAnchoredQuestion({
    elapsedMs: 18 * 60_000,
    turnIndex: 57,
    lastPrimaryEvidenceAtMs: 100_000,
    snapshot,
  });
  assert.equal(advanced.maturity, "shallow");
  assert.deepEqual(advanced.anchorEventIds, ["ev-advanced"]);
  assert.equal(advanced.primaryEvidenceAtMs, 131_000);
});

test("missing evidence produces a wait question instead of inventing a scene", () => {
  const result = planEvidenceAnchoredQuestion({ elapsedMs: 1_000, turnIndex: 0, snapshot: {} });
  assert.equal(result.maturity, "waiting");
  assert.deepEqual(result.anchorEventIds, []);
  assert.match(result.prompt, /还没取得足够/);
});

test("narrated videos anchor plot questions to ASR instead of the latest frame", () => {
  const result = planEvidenceAnchoredQuestion({
    elapsedMs: 90_000,
    turnIndex: 2,
    snapshot: {
      contentMode: "narrated",
      evidenceJournal: [
        { id: "ev-audio", kind: "audio", atMs: 80_000, text: "解说提到主角刚成为猎人" },
        { id: "ev-visual", kind: "visual", atMs: 89_000, text: "画面出现一名握剑男子" },
      ],
    },
  });

  assert.deepEqual(result.anchorEventIds, ["ev-audio"]);
  assert.match(result.prompt, /谁|人物|主角|处境/);
  assert.doesNotMatch(result.prompt, /主角刚成为猎人/);
  assert.doesNotMatch(result.prompt, /刚才解说|声音里|解说刚讲到|能对上|对不上|声画|只说旁白/);
});

test("narrated questions skip broken ASR fragments instead of exposing them to the user", () => {
  const result = planEvidenceAnchoredQuestion({
    elapsedMs: 30_000,
    snapshot: {
      contentMode: "narrated",
      evidenceJournal: [
        { id: "ev-visual", kind: "visual", atMs: 20_000, text: "一名男子站在巨大的石像前" },
        { id: "ev-broken", kind: "audio", atMs: 29_000, text: "그." },
      ],
    },
  });

  assert.deepEqual(result.anchorEventIds, ["ev-visual"]);
  assert.doesNotMatch(result.prompt, /그|证据|原文/);
  assert.match(result.prompt, /画面里的人|在做什么|场景/);
});
