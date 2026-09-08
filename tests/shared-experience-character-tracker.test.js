import test from "node:test";
import assert from "node:assert/strict";

import { createSharedExperienceCharacterTracker } from "../src/ai/shared-experience-character-tracker.js";

test("character tracker uses anonymous session ids and only tentatively joins adjacent shots", () => {
  const tracker = createSharedExperienceCharacterTracker({ adjacencyMs: 6_000 });
  const first = tracker.observe({ descriptor: "黑发男子，穿深色外套", atMs: 1_000 });
  const adjacent = tracker.observe({ descriptor: "黑发男子穿深色外套", atMs: 5_000 });
  const later = tracker.observe({ descriptor: "黑发男子穿深色外套", atMs: 30_000 });

  assert.equal(first.personId, "person-1");
  assert.equal(first.identityStatus, "anonymous");
  assert.equal(adjacent.personId, "person-1");
  assert.equal(adjacent.identityStatus, "tentative");
  assert.equal(later.personId, "person-2");
});

test("character names become confirmed only from user, subtitle, or ASR evidence", () => {
  const tracker = createSharedExperienceCharacterTracker();
  tracker.observe({ descriptor: "短发女子戴眼镜", atMs: 1_000 });

  assert.equal(tracker.confirmIdentity({ personId: "person-1", name: "林雪", source: "visual-model" }), null);
  const confirmed = tracker.confirmIdentity({ personId: "person-1", name: "林雪", source: "subtitle", evidenceId: "ev-8" });
  assert.equal(confirmed.name, "林雪");
  assert.equal(confirmed.identityStatus, "confirmed");
  assert.equal(confirmed.identitySource, "subtitle");
  assert.deepEqual(confirmed.evidenceIds, ["ev-8"]);
});

test("character tracker stays bounded and renders no guessed names", () => {
  const tracker = createSharedExperienceCharacterTracker({ maxCharacters: 2 });
  tracker.observe({ descriptor: "白发老人", atMs: 1 });
  tracker.observe({ descriptor: "红衣女子", atMs: 20_000 });
  tracker.observe({ descriptor: "戴帽男孩", atMs: 40_000 });

  assert.deepEqual(tracker.snapshot().map((item) => item.personId), ["person-2", "person-3"]);
  assert.match(tracker.renderPrompt(), /person-2.*红衣女子/);
  assert.doesNotMatch(tracker.renderPrompt(), /角色名|真实身份/);
});
