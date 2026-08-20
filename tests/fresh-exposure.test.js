import test from "node:test";
import assert from "node:assert/strict";
import {
  createFreshExposureLedger,
  freshExposureFingerprint,
  isFreshExposureSuppressed,
  loadFreshExposureLedger,
  persistFreshExposureLedger,
  recordFreshExposure,
} from "../src/ai/fresh-exposure.js";
import { freshAssociationExposureFingerprint } from "../src/ai/fresh-association.js";

const NOW = Date.parse("2026-08-20T12:00:00Z");
const candidate = {
  freshSourceId: "source:one",
  freshCategory: "games",
  fatigueKey: "games:潮汐线",
  freshTopic: { title: "《潮汐线》上线", shortText: "不应进入账本", canonicalUrl: "https://bad.example" },
};

function storage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    values,
  };
}

test("exposure ledger stores only bounded opaque fingerprints and suppresses repeats", () => {
  const ledger = createFreshExposureLedger({ nowMs: NOW });
  const fingerprint = freshExposureFingerprint(candidate);
  assert.match(fingerprint, /^[0-9a-f]{16}$/);
  assert.equal(recordFreshExposure(ledger, candidate, { nowMs: NOW }), true);
  assert.equal(isFreshExposureSuppressed(ledger, candidate, { nowMs: NOW + 1000 }), true);
  assert.equal(JSON.stringify(ledger).includes("潮汐线"), false);
  assert.equal(JSON.stringify(ledger).includes("bad.example"), false);
});

test("legacy and association candidates share the same named-subject fingerprint", () => {
  const legacy = {
    sourceId: "source:one",
    category: "games",
    title: "《潮汐线》上线",
  };
  const association = {
    freshSourceId: legacy.sourceId,
    freshCategory: legacy.category,
    fatigueKey: "games:潮汐线",
    freshTopic: legacy,
  };
  assert.equal(freshExposureFingerprint(legacy), freshAssociationExposureFingerprint(association));
});

test("rejected exposure remains suppressed until its fixed expiry", () => {
  const ledger = createFreshExposureLedger({ nowMs: NOW });
  recordFreshExposure(ledger, candidate, { outcome: "rejected", nowMs: NOW });
  assert.equal(isFreshExposureSuppressed(ledger, candidate, { nowMs: NOW + 6 * 24 * 60 * 60 * 1000 }), true);
  assert.equal(isFreshExposureSuppressed(ledger, candidate, { nowMs: NOW + 8 * 24 * 60 * 60 * 1000 }), false);
});

test("ledger load and save fail closed and keep at most 64 entries", () => {
  const store = storage();
  const ledger = createFreshExposureLedger({ nowMs: NOW });
  for (let index = 0; index < 80; index += 1) {
    recordFreshExposure(ledger, {
      freshSourceId: `source:${index}`,
      freshCategory: "games",
      fatigueKey: `games:item-${index}`,
    }, { nowMs: NOW });
  }
  persistFreshExposureLedger(store, ledger, { nowMs: NOW });
  const loaded = loadFreshExposureLedger(store, { nowMs: NOW });
  assert.equal(loaded.entries.length, 64);
  store.values.set("kxyy.fresh-exposure.v1", "not-json");
  assert.deepEqual(loadFreshExposureLedger(store, { nowMs: NOW }).entries, []);
});
