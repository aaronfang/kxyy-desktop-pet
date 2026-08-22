const IDENTITY_KEYS = Object.freeze([
  "userName",
  "personaRelationship",
  "personaFacts",
  "personaJokes",
  "personaTreatAs",
]);

function normalizedText(value) {
  return String(value ?? "").trim();
}

function normalizedBackend(value) {
  const backend = normalizedText(value).toLowerCase();
  if (backend === "cosy") return "cosyvoice";
  if (backend === "voxcpm2") return "voxcpm";
  return backend;
}

export function classifySettingsUpdate(current = {}, patch = {}) {
  const personaChanged = Object.hasOwn(patch, "personaCardId") &&
    normalizedText(patch.personaCardId) !== normalizedText(current.personaCardId);
  const backendChanged = Object.hasOwn(patch, "realtimeBackend") &&
    normalizedBackend(patch.realtimeBackend) !== normalizedBackend(current.realtimeBackend);
  const identityChanged = IDENTITY_KEYS.some(
    (key) => Object.hasOwn(patch, key) && patch[key] !== current[key],
  );
  return { personaChanged, backendChanged, identityChanged };
}
