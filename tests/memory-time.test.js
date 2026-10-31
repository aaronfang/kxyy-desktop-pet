import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryTimeText, formatTemporalHistory } from '../src/ai/memory-time.js';

test('yesterday meal retains its event date and ended state independently of consolidation time',()=>{
  const text=memoryTimeText({kind:'episode',text:'晚饭吃了汉堡',occurredAt:1793286000,
    temporal:{eventDate:'2026-10-28',messageAt:1793187000,tense:'past',timeZone:'Asia/Shanghai'}},new Date('2026-10-29T12:00:00+08:00'));
  assert.match(text,/2026-10-28/);assert.match(text,/昨天/);assert.match(text,/历史.*不代表.*当前/);
  assert.match(text,/晚饭吃了汉堡/);
});
test('legacy dates are not promoted to known event dates and future plans never become completed',()=>{
  assert.match(memoryTimeText({kind:'episode',text:'今晚吃汉堡',occurredAt:1793187000}),/发生时间未知/);
  assert.match(memoryTimeText({kind:'fact',text:'喜欢喝茶',occurredAt:1793187000}),/生效.*非事件发生/);
  assert.match(memoryTimeText({kind:'commitment',text:'看电影',occurredAt:1793187000}),/约定到期/);
  assert.match(memoryTimeText({kind:'episode',text:'打算看电影',temporal:{eventDate:'2026-10-28',tense:'planned'}},new Date('2026-10-29T12:00:00+08:00')),/计划.*未证明.*完成/);
});
test('cross-day history is timestamped without modifying stored speech or inventing old timestamps',()=>{
  const history=[{role:'user',content:'今晚吃了汉堡',messageAt:Date.parse('2026-10-28T19:00:00+08:00')/1000},
    {role:'assistant',content:'好吃吗',messageAt:Date.parse('2026-10-28T19:01:00+08:00')/1000},{role:'user',content:'你好'}];
  const out=formatTemporalHistory(history);
  assert.match(out[0].content,/2026-10-28.*19:00/);assert.match(out[2].content,/时间未知/);
  assert.equal(history[0].content,'今晚吃了汉堡');
  assert.deepEqual(out.map(m=>m.role),['user','assistant','user']);
});

test('invalid event dates remain unknown instead of throwing',()=>{
  for(const eventDate of ['2026-99-99','2026-02-30']) {
    assert.match(memoryTimeText({kind:'episode',text:'旧事',temporal:{eventDate}}),/发生时间未知/);
  }
});

test('workspace and realtime retain the source event day through their public renderers',async()=>{
 const {buildWorkspace,renderWorkspaceObservations}=await import('../src/workspace.js');
 const {formatRealtimeMemoryHints}=await import('../src/realtime-memory.js');
 const item={id:'meal',kind:'episode',text:'昨天与朋友吃汉堡庆祝',score:0.9,confidence:0.9,temporal:{eventDate:'2026-10-28',messageAt:1793187000,tense:'past'}};
 assert.match(renderWorkspaceObservations(buildWorkspace({enabled:true,memoryItems:[item],scope:'c/u'}).slots),/2026-10-28/);
 assert.match(formatRealtimeMemoryHints([item]),/2026-10-28/);
});
