import test from 'node:test';
import assert from 'node:assert/strict';
import { createQqPrivateChat } from '../src/ai/qq-private-chat.js';

test('a confirmed external initiative anchors the next owner response without old-topic recall or Memory evidence',async()=>{
 const requests=[],recalls=[],sent=[];
 const client=createQqPrivateChat({getScope:()=>({cardId:'',nickname:'主人',epoch:0}),claim:async()=>'lease',recall:async q=>{recalls.push(q);return [];},buildSystem:()=>'',generate:async r=>{requests.push(r);return '明白，等用得上再考虑。';},send:async(...args)=>{sent.push(args);return 'sent';},planInitiative:async()=>({action:'send',score:17,text:'看到一条系统隐私权限的新消息，觉得单独控制权限挺实用。'})});
 const input=(nonce,text)=>({nonce,text,cardId:'',nickname:'主人'});
 await client.receive(input('old','聊个早先的健身话题'));
 assert.equal(await client.initiate({nonce:'share',cardId:'',nickname:'主人',kind:'share',channel:'qq',external:true,source:'原始来源数据不得进入用户历史'}),'sent');
 assert.equal(await client.receive(input('reply','可能以后有用，不过目前用不到')),'sent');
 const next=requests.at(-1);
 assert.equal(next.shareContext.text,'看到一条系统隐私权限的新消息，觉得单独控制权限挺实用。');
 assert.deepEqual(next.history,[]);assert.equal(next.memory,'');
 assert.deepEqual(recalls,['聊个早先的健身话题']);
 assert.equal(next.external,true);assert.equal(next.searchRequested,false);
 assert.equal(sent.at(-1)[3].external,true,'source-derived followup stays outside native Memory');
 assert.doesNotMatch(JSON.stringify(next),/原始来源数据/);
 await client.receive(input('later','换个话题，我准备出门'));
 assert.equal(requests.at(-1).shareContext,null);
 assert.deepEqual(requests.at(-1).history,[],'external context does not spill into ordinary history');
});

test('temporary share context expires, follows identity and lease boundaries, and requires confirmed text',async()=>{
 for(const boundary of ['expires','clock-backward','scope','lease','invalidate','unknown','failed']){
  let at=1000000,epoch=0,lease='first';const requests=[];
  const client=createQqPrivateChat({now:()=>at,getScope:()=>({cardId:'',nickname:'主人',epoch}),claim:async()=>lease,recall:async()=>[],buildSystem:()=>'',generate:async r=>{requests.push(r);return '收到';},send:async nonce=>nonce==='share'&&['unknown','failed'].includes(boundary)?boundary:'sent',planInitiative:async()=>({action:'send',score:17,text:'这是一条已分享的系统消息。'})});
  await client.receive({nonce:'old',text:'之前的话题',cardId:'',nickname:'主人'});
  await client.initiate({nonce:'share',cardId:'',nickname:'主人',kind:'share',external:true,channel:'qq',source:'资料'});
  if(boundary==='expires')at+=600000;
  if(boundary==='clock-backward')at--;
  if(boundary==='scope')epoch++;
  if(boundary==='lease')lease='new';
  if(boundary==='invalidate')client.invalidate();
  await client.receive({nonce:'next',text:'目前不需要',cardId:'',nickname:'主人'});
  assert.equal(requests.at(-1).shareContext,null,boundary);
 }
});

test('new owner input reconciles only a confirmed share prefix while its ACK is settling',async()=>{
 let receipt,started;const ready=new Promise(r=>started=r);const requests=[];
 const client=createQqPrivateChat({getScope:()=>({cardId:'',nickname:'主人',epoch:0}),claim:async()=>'lease',recall:async()=>[],buildSystem:()=>'',generate:async r=>{requests.push(r);return '暂时不需要也没关系。';},send:async nonce=>nonce==='share'?new Promise(r=>{receipt=r;started();}):'sent',planInitiative:async()=>({action:'send',score:17,text:'系统权限可以分开设置。\n没有确认的第二段。'})});
 const pending=client.initiate({nonce:'share',cardId:'',nickname:'主人',kind:'share',external:true,channel:'qq',source:'资料'});
 await ready;
 const reply=client.receive({nonce:'owner',text:'目前用不到',cardId:'',nickname:'主人'});
 receipt({outcome:'partial',deliveredText:'系统权限可以分开设置。'});
 await Promise.all([pending,reply]);
 assert.equal(requests[0].shareContext.text,'系统权限可以分开设置。');
 assert.doesNotMatch(JSON.stringify(requests),/没有确认的第二段/);
});

test('an explicit topic switch or personal recall after a share keeps ordinary Memory available',async()=>{
 for(const text of ['换个话题，我想聊之前那个约定','你还记得上次我提的项目吗']) {
  const requests=[],recalls=[];
  const client=createQqPrivateChat({getScope:()=>({cardId:'',nickname:'主人',epoch:0}),claim:async()=>'lease',recall:async q=>{recalls.push(q);return [{kind:'fact',text:'项目使用本地存储'}];},buildSystem:()=>'',generate:async r=>{requests.push(r);return '接着聊你的项目。';},send:async()=> 'sent',planInitiative:async()=>({action:'send',score:17,text:'看到系统权限可以分开设置。'})});
  await client.initiate({nonce:'share',cardId:'',nickname:'主人',kind:'share',external:true,channel:'qq',source:'资料'});
  await client.receive({nonce:'owner',text,cardId:'',nickname:'主人'});
  assert.equal(requests[0].shareContext,null,text);assert.deepEqual(recalls,[text]);assert.equal(requests[0].external,false);
 }
});
test('partial delivery contributes only confirmed text to following history',async()=>{
 const requests=[];
 const client=createQqPrivateChat({getScope:()=>({cardId:'',nickname:'主人',epoch:0}),claim:async()=>'lease',recall:async()=>[],buildSystem:()=>'',generate:async r=>{requests.push(r);return '收到。\n\n没送出的内容';},send:async()=>({outcome:'partial',deliveredText:'收到。'})});
 const input=n=>({nonce:n,text:'你好',cardId:'',nickname:'主人',replyMode:'text'});
 assert.equal(await client.receive(input('1')),'partial');await client.receive(input('2'));
 assert.equal(requests[1].history.at(-1).content,'收到。');
 assert.ok(!requests[1].history.some(m=>m.content.includes('没送出')));
});

test('initiative may remain silent, uses no fake user turn and cancels on new user input',async()=>{
 const sent=[],requests=[];let action='wait',resolve;
 const client=createQqPrivateChat({getScope:()=>({cardId:'',nickname:'主人',epoch:0}),claim:async()=>'lease',recall:async()=>[],buildSystem:()=>'',generate:async r=>{requests.push(r);return '正常回复';},send:async(n,text,_a,m)=>{sent.push({n,text,m});return 'sent';},planInitiative:async()=> action==='pending'?await new Promise(r=>resolve=r):{action,text:'昨天的事情后来怎么样？'}});
 const initiative=n=>({nonce:n,cardId:'',nickname:'主人',source:'[昨天提及] 明天有面试'});
 assert.equal(await client.initiate(initiative('i1')),'silent');assert.equal(sent.length,0);
 action='send';assert.equal(await client.initiate(initiative('i2')),'sent');
 assert.equal(sent[0].m.proactive,true);
 await client.receive({nonce:'u',cardId:'',nickname:'主人',text:'你好'});
 assert.ok(!requests[0].history.some(m=>m.role==='user'), 'initiative must not fabricate owner messages');
 action='pending';const pending=client.initiate(initiative('i3'));await new Promise(r=>setImmediate(r));
 await client.receive({nonce:'u2',cardId:'',nickname:'主人',text:'我有别的问题'});resolve({action:'send',text:'过时主动发言'});
 assert.equal(await pending,'cancelled');assert.ok(!sent.some(s=>s.text==='过时主动发言'));
});

test('new input keeps the confirmed prefix from an interrupted delivery in following context',async()=>{
 const requests=[];let resolveReceipt,started;
 const ready=new Promise(r=>started=r);
 const client=createQqPrivateChat({getScope:()=>({cardId:'',nickname:'主人',epoch:0}),claim:async()=>'lease',recall:async()=>[],buildSystem:()=>'',generate:async r=>{requests.push(r);return '已送第一段。\n\n未送第二段。';},send:async nonce=>nonce==='old'?new Promise(r=>{resolveReceipt=r;started();}):'sent'});
 const event=nonce=>({nonce,cardId:'',nickname:'主人',text:'你好',replyMode:'text'});
 const old=client.receive(event('old'));await ready;
 const next=client.receive(event('next'));
 resolveReceipt({outcome:'partial',deliveredText:'已送第一段。'});
 await Promise.all([old,next]);
 assert.ok(requests[1].history.some(m=>m.role==='assistant'&&m.content==='已送第一段。'));
 assert.ok(!requests[1].history.some(m=>m.content.includes('未送第二段')));
});

test('source-backed sharing requires a concrete worthwhile proposal and may rest without messaging',async()=>{
 let score=5;const sent=[],declined=[];
 const client=createQqPrivateChat({getScope:()=>({cardId:'',nickname:'主人',epoch:0}),recall:async()=>[],buildSystem:()=>'',generate:async()=>'',send:async(...args)=>{sent.push(args);return 'sent';},decline:async(n,a)=>declined.push([n,a]),planInitiative:async()=>({action:'send',score,text:'这条资料让我想到一个具体的设计取舍。'})});
 const event=nonce=>({nonce,cardId:'',nickname:'主人',kind:'share',source:'授权本地缓存中的真实摘要',external:true});
 assert.equal(await client.initiate(event('low')),'silent');assert.equal(sent.length,0);
 assert.deepEqual(declined,[['low','drop']]);
 score=16;assert.equal(await client.initiate(event('good')),'sent');assert.equal(sent.length,1);
});

test('daily companionship can use a light topic without news scoring or a fabricated owner turn',async()=>{
 const plans=[],requests=[],sent=[];let action='send';
 const client=createQqPrivateChat({getScope:()=>({cardId:'',nickname:'主人',epoch:0}),claim:async()=>'lease',recall:async()=>[],buildSystem:()=>'',generate:async r=>{requests.push(r);return '正常回复';},send:async(...args)=>{sent.push(args);return 'sent';},planInitiative:async p=>{plans.push(p);return {action,score:0,text:'我在想，游戏里留一点没说透的故事还挺有意思。'};}});
 const event=nonce=>({nonce,cardId:'',nickname:'主人',kind:'daily',channel:'qq',source:'无可引用新资讯；可以围绕游戏轻松聊聊。',external:false});
 assert.equal(await client.initiate(event('daily')),'sent');
 assert.equal(plans[0].kind,'daily');assert.deepEqual(plans[0].history,[]);
 assert.equal(sent[0][3].proactive,true);
 await client.receive({nonce:'u',cardId:'',nickname:'主人',text:'继续说'});
 assert.deepEqual(requests[0].history.map(m=>m.role),['assistant']);
 assert.ok(!requests[0].history.some(m=>m.content.includes('无可引用新资讯')));
 action='wait';assert.equal(await client.initiate(event('daily-wait')),'silent');assert.equal(sent.length,2);
});

test('merged owner inputs preserve each original date in following context and forward only fixed rhythm',async()=>{
 const requests=[],sent=[];
 const client=createQqPrivateChat({getScope:()=>({cardId:'',nickname:'主人',epoch:0}),claim:async()=>'lease',recall:async()=>[],buildSystem:()=>'',generate:async r=>{requests.push(r);return {text:'我还有个想法。',rhythm:'open'};},send:async(...r)=>{sent.push(r);return 'sent';}});
 await client.receive({nonce:'burst',text:'昨天的晚饭\n今天的安排',cardId:'',nickname:'主人',sourceMessages:[{role:'user',content:'昨天的晚饭',messageAt:1793200000},{role:'user',content:'今天的安排',messageAt:1793300000}]});
 await client.receive({nonce:'next',text:'接着说',cardId:'',nickname:'主人'});
 assert.deepEqual(requests[1].history.filter(m=>m.role==='user').map(m=>m.messageAt),[1793200000,1793300000]);
 assert.equal(sent[0][3].rhythm,'open');
 assert.equal(await client.receive({nonce:'oversize',text:'长'.repeat(2001),cardId:'',nickname:'主人'}),'ignored');
});
