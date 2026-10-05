const categories = [
  "evidence", "evidence", "current",
  "evidence", "current", "uncertainty",
  "current", "evidence", "continuity",
  "current", "continuity", "uncertainty",
  "continuity", "evidence", "discussion",
  "continuity", "causal", "uncertainty",
  "character", "continuity", "evidence",
  "causal", "character", "discussion",
  "continuity", "judgment", "uncertainty",
  "character", "causal", "checkpoint",
];

const offsetsByMinute = [
  // The first slot allows Mage-VL and the local voice service to finish cold start
  // before the first evidence-anchored question is resolved.
  [30_000, 40_000, 55_000],
  [5_000, 12_000, 55_000],
  [8_000, 35_000, 48_000],
  [2_000, 42_000, 54_000],
  [15_000, 25_000, 38_000],
];

export function buildStressPlan() {
  return {
    durationMs: 30 * 60 * 1000,
    turns: Array.from({ length: 90 }, (_, index) => {
      const minute = Math.floor(index / 3);
      const offset = offsetsByMinute[minute % offsetsByMinute.length][index % 3];
      return {
        atMs: minute * 60_000 + offset,
        category: categories[index % categories.length],
        dynamic: true,
      };
    }),
  };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.stdout.write(JSON.stringify(buildStressPlan()));
}
