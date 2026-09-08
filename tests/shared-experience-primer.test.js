import test from "node:test";
import assert from "node:assert/strict";

import {
  createSharedExperiencePrimerGate,
  parseSharedExperienceViewingStatement,
  requestSharedExperiencePrimer,
} from "../src/ai/shared-experience-primer.js";

test("viewing statement parser accepts explicit co-viewing declarations only", () => {
  assert.deepEqual(parseSharedExperienceViewingStatement("我们在看《暗影君主》的解说视频"), {
    title: "暗影君主",
    format: "解说",
    statement: "我们在看《暗影君主》的解说视频",
  });
  assert.deepEqual(parseSharedExperienceViewingStatement("我们一起看 星际穿越 电影吧"), {
    title: "星际穿越",
    format: "电影",
    statement: "我们一起看 星际穿越 电影吧",
  });
  assert.equal(parseSharedExperienceViewingStatement("暗影君主很好看"), null);
  assert.equal(parseSharedExperienceViewingStatement("这个窗口标题是暗影君主"), null);
  assert.equal(parseSharedExperienceViewingStatement("我们在看游戏解说视频"), null);
  assert.equal(parseSharedExperienceViewingStatement("我们在看一段游戏解说"), null);
});

test("primer requires an explicit user viewing statement and ignores title metadata", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; };
  assert.equal(await requestSharedExperiencePrimer({ title: "暗影君王", fetchImpl }), null);
  assert.equal(await requestSharedExperiencePrimer({ userStatement: "暗影君主很好看", fetchImpl }), null);
  assert.equal(calls, 0);
});

test("primer searches once then exposes only bounded spoiler-free identity fields", async () => {
  const bodies = [];
  const fetchImpl = async (url, init) => {
    bodies.push({ url, body: JSON.parse(init.body) });
    if (url.endsWith("/api/web-observations")) {
      return {
        ok: true,
        json: async () => ({
          status: "ok",
          provider: "tavily",
          items: [{
            title: "我独自升级作品资料",
            sourceUrl: "https://example.com/work",
            fetchedAt: "2026-09-06T00:00:00.000Z",
            text: "《我独自升级》又名 Solo Leveling，这里含有作品简介、人物名称以及结局剧透。",
          }, {
            title: "Solo Leveling 基础资料",
            sourceUrl: "https://example.org/work",
            fetchedAt: "2026-09-06T00:00:00.000Z",
            text: "我独自升级的主角是程肖宇。",
          }],
        }),
      };
    }
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"canonicalTitle":"我独自升级","aliases":["Solo Leveling"],"premise":"低等级猎人成长故事","names":["程肖宇"],"spoilerFree":true,"identityConfidence":"high","ambiguous":false,"supportingResultIndexes":[1,2],"competingTitles":[]}' } }],
      }),
    };
  };

  const primer = await requestSharedExperiencePrimer({
    apiBase: "http://127.0.0.1:1234",
    userStatement: "我们在看《暗影君主》的解说视频",
    enabled: true,
    provider: "tavily",
    fetchImpl,
  });

  assert.equal(bodies.length, 2);
  assert.match(bodies[0].body.query, /暗影君主.*无剧透/);
  assert.match(bodies[1].body.messages[0].content, /禁止输出剧情进展、反转、结局/);
  assert.deepEqual(primer, {
    title: "暗影君主",
    canonicalTitle: "我独自升级",
    aliases: ["Solo Leveling"],
    premise: "低等级猎人成长故事",
    names: ["程肖宇"],
    facts: ["正式名：我独自升级", "别名：Solo Leveling", "基础设定：低等级猎人成长故事", "常见人名：程肖宇"],
  });
  assert.doesNotMatch(JSON.stringify(primer), /结局剧透/);
});

test("primer fails closed when an ambiguous nickname can refer to another work", async () => {
  let call = 0;
  const fetchImpl = async () => {
    call += 1;
    return call === 1
      ? {
          ok: true,
          json: async () => ({
            status: "ok",
            provider: "tavily",
            items: [
              { title: "暗影君主词条一", text: "有人用暗影君主称呼《我独自升级》的主角。" },
              { title: "暗影君主词条二", text: "暗影也可能指《想要成为影之实力者！》。" },
            ],
          }),
        }
      : {
          ok: true,
          json: async () => ({
            choices: [{ message: { content: '{"canonicalTitle":"想要成为影之实力者！","aliases":["暗影君主"],"premise":"少年暗中行动","names":["席德"],"spoilerFree":true,"identityConfidence":"low","ambiguous":true,"supportingResultIndexes":[2],"competingTitles":["我独自升级"]}' } }],
          }),
        };
  };

  assert.equal(await requestSharedExperiencePrimer({
    apiBase: "http://127.0.0.1:1234",
    userStatement: "我们在看《暗影君主》的解说视频",
    enabled: true,
    provider: "tavily",
    fetchImpl,
  }), null);
});

test("primer fails closed on malformed extraction", async () => {
  let call = 0;
  const fetchImpl = async () => {
    call += 1;
    return call === 1
      ? { ok: true, json: async () => ({ status: "ok", provider: "tavily", items: [{ title: "x", sourceUrl: "https://example.com", fetchedAt: "2026-09-06T00:00:00Z", text: "x" }] }) }
      : { ok: true, json: async () => ({ choices: [{ message: { content: "not json" } }] }) };
  };
  assert.equal(await requestSharedExperiencePrimer({
    apiBase: "http://127.0.0.1:1", userStatement: "我们一起看《作品》电影", enabled: true, provider: "tavily", fetchImpl,
  }), null);
});

test("primer gate searches at most once per shared-experience session", async () => {
  const seen = [];
  const gate = createSharedExperiencePrimerGate({
    requestPrimer: async ({ userStatement }) => {
      seen.push(userStatement);
      return { title: "暗影君主", facts: ["正式名：我独自升级"] };
    },
  });

  const enabled = { apiBase: "http://127.0.0.1:1234", enabled: true, provider: "tavily" };
  assert.equal(await gate.consider({ ...enabled, userStatement: "窗口标题：暗影君主" }), null);
  assert.deepEqual(await gate.consider({ ...enabled, userStatement: "我们在看《暗影君主》的解说视频" }), {
    title: "暗影君主",
    facts: ["正式名：我独自升级"],
  });
  assert.equal(await gate.consider({ ...enabled, userStatement: "我们一起看《星际穿越》电影" }), null);
  assert.deepEqual(seen, ["我们在看《暗影君主》的解说视频"]);
  assert.deepEqual(gate.snapshot(), {
    attempted: true,
    status: "ready",
    viewing: {
      title: "暗影君主",
      format: "解说",
      statement: "我们在看《暗影君主》的解说视频",
    },
  });
});

test("disabled grounding does not consume a later explicit viewing declaration", async () => {
  let calls = 0;
  const gate = createSharedExperiencePrimerGate({ requestPrimer: async () => { calls += 1; return null; } });
  const statement = "我们在看《暗影君主》的解说视频";
  assert.equal(await gate.consider({ apiBase: "http://127.0.0.1:1234", userStatement: statement, enabled: false, provider: "tavily" }), null);
  assert.equal(gate.snapshot().attempted, false);
  await gate.consider({ apiBase: "http://127.0.0.1:1234", userStatement: statement, enabled: true, provider: "tavily" });
  assert.equal(calls, 1);
  assert.equal(gate.snapshot().status, "empty");
});
