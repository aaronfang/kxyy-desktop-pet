const STRONG_IDENTITY_CLAIM = /[@《》]|(?:来自|出自|取自).{0,24}(?:作品|动漫|动画|电影|电视剧|番剧|游戏)|(?:这是|画面(?:中|里)?(?:展示|显示|出现)?(?:的)?是|该画面(?:来自|出自)).{1,36}(?:作品|动漫|动画|电影|电视剧|番剧|游戏|中的角色|里的角色)|(?:作品|片名|动漫|动画|电影|电视剧|番剧|游戏).{0,12}(?:叫|名为|是|中的|里的)|(?:角色|人物).{0,8}(?:叫|名为|名字是|是)/u;
const LEADING_ACTOR = /^(?:画面(?:中|里)?[，,:：]?)?([\p{Script=Han}]{2,4}|[A-Z][A-Za-z]{2,20})(?=正在|正|在|与|和|被|用|拿着|站在|走|跑|跳|看|说|穿)/u;
const GENERIC_ACTORS = new Set([
  "人物", "角色", "主角", "男子", "女子", "男人", "女人", "男孩", "女孩", "老人", "孩子",
  "一人", "一名男子", "一名女子", "一个男人", "一个女人", "黑发男子", "黑发女子", "白发男子", "白发女子",
]);

function isIdentityClaim(clause) {
  if (STRONG_IDENTITY_CLAIM.test(clause)) return true;
  const actor = clause.match(LEADING_ACTOR)?.[1] || "";
  return Boolean(actor && !GENERIC_ACTORS.has(actor));
}

export function filterVisualIdentityClaims(value) {
  const text = String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 900);
  if (!text) return { summary: "", identityFiltered: false };

  let identityFiltered = false;
  const clauses = text.split(/(?<=[，,。！？；;])/u).map((clause) => clause.trim()).filter(Boolean);
  const kept = clauses.filter((clause) => {
    if (!isIdentityClaim(clause)) return true;
    identityFiltered = true;
    return false;
  });
  return { summary: kept.join("").slice(0, 360), identityFiltered };
}

export function extractVisualCharacterDescriptors(value) {
  const { summary } = filterVisualIdentityClaims(value);
  if (!summary) return [];
  const descriptors = [];
  const pattern = /(?:一名|一个)((?:(?![，,。！？；;]).){1,24}?(?:男子|女子|男孩|女孩|老人|孩子)(?:穿(?:着)?[^站走跑坐拿看说，,。！？；;]{1,12})?)/gu;
  for (const match of summary.matchAll(pattern)) {
    const descriptor = String(match[1] || "").replace(/\s+/g, " ").trim().slice(0, 60);
    if (descriptor && !descriptors.includes(descriptor)) descriptors.push(descriptor);
    if (descriptors.length >= 4) break;
  }
  return descriptors;
}
