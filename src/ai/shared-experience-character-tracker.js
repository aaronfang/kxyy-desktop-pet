const ALLOWED_IDENTITY_SOURCES = new Set(["user", "subtitle", "asr"]);

function clean(value, maxChars = 100) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

function fingerprint(value) {
  return clean(value)
    .replace(/^(?:画面(?:中|里)?|一名|一个)+/u, "")
    .replace(/[，,。.!！？；;：:\s]/gu, "")
    .toLowerCase();
}

function copyTrack(track) {
  return { ...track, evidenceIds: [...track.evidenceIds] };
}

export function createSharedExperienceCharacterTracker({ maxCharacters = 12, adjacencyMs = 6_000 } = {}) {
  const limit = Math.max(1, Math.min(32, Number(maxCharacters) || 12));
  const adjacentWindow = Math.max(500, Math.min(15_000, Number(adjacencyMs) || 6_000));
  const tracks = [];
  let sequence = 0;

  return {
    observe({ descriptor = "", atMs = Date.now(), evidenceId = "" } = {}) {
      const safeDescriptor = clean(descriptor);
      const key = fingerprint(safeDescriptor);
      const seenAtMs = Number.isFinite(Number(atMs)) ? Number(atMs) : Date.now();
      if (!key) return null;
      const previous = tracks[tracks.length - 1];
      if (previous && previous.fingerprint === key && seenAtMs >= previous.lastSeenAtMs
          && seenAtMs - previous.lastSeenAtMs <= adjacentWindow) {
        previous.lastSeenAtMs = seenAtMs;
        previous.observations += 1;
        if (previous.identityStatus === "anonymous") previous.identityStatus = "tentative";
        const safeEvidenceId = clean(evidenceId, 80);
        if (safeEvidenceId && !previous.evidenceIds.includes(safeEvidenceId)) previous.evidenceIds.push(safeEvidenceId);
        return copyTrack(previous);
      }

      const track = {
        personId: `person-${++sequence}`,
        descriptor: safeDescriptor,
        identityStatus: "anonymous",
        name: "",
        identitySource: "",
        firstSeenAtMs: seenAtMs,
        lastSeenAtMs: seenAtMs,
        observations: 1,
        evidenceIds: clean(evidenceId, 80) ? [clean(evidenceId, 80)] : [],
        fingerprint: key,
      };
      tracks.push(track);
      while (tracks.length > limit) tracks.shift();
      return copyTrack(track);
    },

    confirmIdentity({ personId = "", name = "", source = "", evidenceId = "" } = {}) {
      if (!ALLOWED_IDENTITY_SOURCES.has(source)) return null;
      const track = tracks.find((item) => item.personId === personId);
      const safeName = clean(name, 60);
      if (!track || !safeName) return null;
      track.name = safeName;
      track.identityStatus = "confirmed";
      track.identitySource = source;
      const safeEvidenceId = clean(evidenceId, 80);
      if (safeEvidenceId && !track.evidenceIds.includes(safeEvidenceId)) track.evidenceIds.push(safeEvidenceId);
      return copyTrack(track);
    },

    snapshot() {
      return tracks.map(({ fingerprint: _fingerprint, ...track }) => copyTrack(track));
    },

    renderPrompt() {
      if (!tracks.length) return "";
      const lines = [
        "【会话人物标签】",
        "这些标签只用于跨镜头保持称呼。暂定关联不等于确认；不要根据外观补名字。",
      ];
      tracks.forEach((track) => {
        const label = track.name && track.identityStatus === "confirmed"
          ? `${track.personId}（已确认：${track.name}，来源=${track.identitySource}）`
          : `${track.personId}（${track.identityStatus === "tentative" ? "相邻镜头暂定" : "匿名"}）`;
        lines.push(`- ${label}：${track.descriptor}`);
      });
      return lines.join("\n");
    },

    clear() {
      tracks.length = 0;
    },
  };
}
