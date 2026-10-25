import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { reloadAssets, buildOnlineAbstractSystemPrompt } from '../src/ai/persona.js';

const builder = fs.readFileSync(new URL('../scripts/build-persona-enc.mjs', import.meta.url));
const yuanYuan = JSON.parse(fs.readFileSync(new URL('../persona-cards/kxyy-yuanyuan/persona-card.json', import.meta.url)));

async function bundledAssets(card) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kxyy-persona-bundle-'));
  const originalFetch = globalThis.fetch;
  try {
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.mkdirSync(path.join(root, 'persona-cards/kxyy-yuanyuan'), { recursive: true });
    fs.writeFileSync(path.join(root, 'scripts/build-persona-enc.mjs'), builder);
    fs.writeFileSync(path.join(root, 'persona-cards/kxyy-yuanyuan/persona-card.json'), JSON.stringify(card));
    // No personal profile is needed to test the shipped persona contract.
    fs.writeFileSync(path.join(root, 'persona-cards/user-profile.json'), '{}');
    execFileSync(process.execPath, [path.join(root, 'scripts/build-persona-enc.mjs')], { stdio: 'pipe' });
    const encrypted = fs.readFileSync(path.join(root, 'src-tauri/assets/persona-assets.enc'));
    const key = Buffer.from('kxyy-prompt-v1');
    const plain = Buffer.from(encrypted.map((byte, index) => byte ^ key[index % key.length]));
    globalThis.fetch = async () => new Response(plain, { headers: { 'Content-Type': 'application/json' } });
    return await reloadAssets();
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('shipped encrypted default retains YuanYuan identity through loading and abstract prompting', async () => {
  const assets = await bundledAssets(yuanYuan);
  assert.equal(assets.displayName, yuanYuan.identity.name);
  assert.equal(assets.identity.name, yuanYuan.identity.name);
  assert.equal(assets.activeCardId, '');
  const prompt = buildOnlineAbstractSystemPrompt(assets, { name: '测试用户' });
  assert.match(prompt, /你是「开心元元」/);
  assert.match(prompt, /元元表达 DNA/);
  assert.doesNotMatch(prompt, /你是「角色」/);
});

test('bundled custom cards retain their own identity and metadata name fallback', async () => {
  const named = await bundledAssets({ meta: { name: '元数据名称' }, identity: { name: '测试向导' }, system_prompt: '测试人设' });
  assert.equal(named.displayName, '测试向导');
  const prompt = buildOnlineAbstractSystemPrompt(named, { name: '测试用户' });
  assert.match(prompt, /你是「测试向导」/);
  assert.doesNotMatch(prompt, /元元表达 DNA/);
  const fallback = await bundledAssets({ meta: { name: '测试书友' }, system_prompt: '测试人设' });
  assert.equal(fallback.displayName, '测试书友');
  assert.deepEqual(fallback.identity, {});
});
