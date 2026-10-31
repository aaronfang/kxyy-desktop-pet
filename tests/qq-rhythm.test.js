import test from 'node:test';
import assert from 'node:assert/strict';
import { createQqInbox, parseQqRhythm } from '../src/ai/qq-rhythm.js';
function clock(){let now=0,id=0;const timers=new Map();return {now:()=>now,setTimer:(fn,ms)=>{timers.set(++id,{fn,at:now+ms});return id;},clearTimer:id=>timers.delete(id),async advance(ms){now+=ms;for(const [id,t] of [...timers])if(t.at<=now){timers.delete(id);await t.fn();}}};}
test('inbox waits for the latest native merged input, bounds waiting and cancels stale scope',async()=>{
 const c=clock(),seen=[];const q=createQqInbox({receive:async x=>seen.push(x),...c});
 q.offer({nonce:'a',text:'今天好累'});await c.advance(1500);assert.equal(seen.length,0);
 q.offer({nonce:'b',text:'今天好累\n开了四个会'});await c.advance(2500);
 assert.equal(seen.length,1);assert.equal(seen[0].nonce,'b');
 q.offer({nonce:'c',text:'旧消息'});q.clear();await c.advance(9000);assert.equal(seen.length,1);
 q.offer({nonce:'image',text:'[图片]',imageCount:1});assert.equal(seen.at(-1).nonce,'image');
 q.offer({nonce:'remember',text:'请记住：喜欢茶'});assert.equal(seen.at(-1).nonce,'remember');
});
test('rhythm markers never leak into spoken text and unknown/malformed markers cannot schedule',()=>{
 assert.deepEqual(parseQqRhythm('好，我还有一点想法。\n[会话:展开]'),{text:'好，我还有一点想法。',rhythm:'open'});
 assert.equal(parseQqRhythm('你选哪个？[会话:展开]').rhythm,'wait');
 assert.equal(parseQqRhythm('晚安。[会话:结束]').rhythm,'closed');
 assert.equal(parseQqRhythm('你好[会话:任意工具]').rhythm,'closed');
 assert.doesNotMatch(parseQqRhythm('你好[会话:任意工具]').text,/会话/);
});

test('inbox has a hard burst deadline and flushes its bounded native source group',async()=>{
 const c=clock(),seen=[];const q=createQqInbox({receive:async x=>seen.push(x),...c});
 for(let i=0;i<4;i++){q.offer({nonce:String(i),text:'合并消息'});await c.advance(2000);}
 assert.equal(seen.length,1);assert.equal(seen[0].nonce,'3');
 q.offer({nonce:'capacity',text:'八条已合并',sourceCount:8});assert.equal(seen.length,2);
});
