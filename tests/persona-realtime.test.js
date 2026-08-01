import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const root = new URL("../", import.meta.url);
const chatSource = fs.readFileSync(new URL("src/chat.js", root), "utf8");
const tauriConfig = JSON.parse(
  fs.readFileSync(new URL("src-tauri/tauri.conf.json", root), "utf8"),
);

function sourceBetween(start, end) {
  const startIndex = chatSource.indexOf(start);
  const endIndex = chatSource.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing source marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing source marker: ${end}`);
  return chatSource.slice(startIndex, endIndex);
}

test("realtime call controls are available to every persona card", () => {
  const controls = sourceBetween(
    "function updatePersonaControls()",
    "function lastRealUserMessage()",
  );
  const startCall = sourceBetween("async function startCall()", "async function endCall(");
  const toggleCall = sourceBetween("function toggleCall()", "function buildStickerGrid()");

  assert.match(controls, /callBtn\.hidden = false/);
  assert.doesNotMatch(controls, /callBtn\.hidden = !kxyy/);
  assert.doesNotMatch(startCall, /isKxyyPersona/);
  assert.doesNotMatch(toggleCall, /isKxyyPersona/);
});

test("bundled non-kxyy persona cards include their own local voice references", () => {
  const resources = tauriConfig.bundle.resources;
  const cards = [
    ["bazi-persona", "ref.mp3"],
    ["elon-musk", "ref.wav"],
  ];

  for (const [cardId, audioFile] of cards) {
    const source = `../scripts/local-realtime/assets/${cardId}`;
    assert.equal(
      resources[source],
      `scripts/local-realtime/assets/${cardId}`,
      `${cardId} voice assets must be bundled`,
    );
    assert.equal(
      fs.existsSync(new URL(`scripts/local-realtime/assets/${cardId}/${audioFile}`, root)),
      true,
      `${cardId} must include ${audioFile}`,
    );
    assert.equal(
      fs.existsSync(new URL(`scripts/local-realtime/assets/${cardId}/ref.txt`, root)),
      true,
      `${cardId} must include ref.txt`,
    );
  }
});

test("call capsule starts native dragging only from the waveform hot zone", () => {
  assert.match(chatSource, /callCapsuleWaveEl\?\.addEventListener\("mousedown"/);
  assert.doesNotMatch(chatSource, /callCapsuleEl\?\.addEventListener\("mousedown"/);
  assert.match(chatSource, /invoke\("start_chat_capsule_drag"\)/);
});
