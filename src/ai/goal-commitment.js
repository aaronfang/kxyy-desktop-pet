function stableId(value) {
  let hash = 2166136261;
  for (const char of String(value || "")) { hash ^= char.codePointAt(0); hash = Math.imul(hash, 16777619); }
  return `goal-commitment-${(hash >>> 0).toString(16)}`;
}

export function commitmentToGoal(commitment, kind = "todo") {
  if (!commitment || typeof commitment !== "object" || !commitment.id || !String(commitment.text || "").trim()) return null;
  if (kind !== "todo" && kind !== "long_term_goal") return null;
  const sourceRef = String(commitment.id).slice(0, 120);
  return Object.freeze({
    id: stableId(`${sourceRef}:${kind}`),
    kind,
    title: String(commitment.text).trim().slice(0, 120),
    description: "",
    dueAtMs: Number.isSafeInteger(commitment.dueAt) ? commitment.dueAt : null,
    source: "memory_commitment",
    sourceRef,
    reminderPolicy: "manual_only",
    idempotencyKey: `memory-commitment:${sourceRef}:${kind}`,
  });
}

export function canImplicitlyWriteCommitmentFromGoal() {
  return false;
}
