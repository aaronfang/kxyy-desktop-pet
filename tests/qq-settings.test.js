import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
test('hidden QQ host keeps its background execution policy in the packaged window config',()=>{
  const config=JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json',import.meta.url),'utf8'));
  const chat=config.app.windows.find(window=>window.label==='chat');
  assert.equal(chat.visible,false);
  assert.equal(chat.backgroundThrottling,'disabled');
});
const source=readFileSync(new URL('../src/settings.js',import.meta.url),'utf8').replace(/\r\n/g,'\n');
function mount(invoke) {
  const nodes=new Map(),tabs=new Map();
  const el=id=>{if(!nodes.has(id))nodes.set(id,{value:'',checked:false,disabled:false,textContent:'',events:{},addEventListener(name,cb){this.events[name]=cb;}});return nodes.get(id);};
  const snippet=source.slice(source.indexOf('const qqStatusLabels='),source.indexOf('async function init()'));
  vm.runInNewContext(snippet,{el,invoke,document:{querySelector:key=>{const node=el(key);tabs.set(key,node);return node;}}});
  return {el,refresh:async()=>el('qqRefresh').events.click()};
}
test('QQ settings saves independently and never reads a stored token back into the form',async()=>{
  const calls=[];
  const ui=mount(async(command,args)=>{calls.push({command,args});if(command==='qq_get_config')return {enabled:true,wsUrl:'ws://127.0.0.1:3001',ownerId:'12345678',botId:'87654321',cardId:'',nickname:'主人',hasToken:true,status:'connected'};});
  const {el}=ui;await el('qqRefresh').events.click();
  assert.match(el('qqStatus').textContent,/已保存 token/);assert.equal(el('qqToken').value,'');
  el('qqEnabled').checked=true;el('qqOwnerId').value='12345678';el('qqBotId').value='87654321';el('qqNickname').value='主人';
  el('qqWsUrl').value='ws://127.0.0.1:3001';el('qqToken').value='test-local-only';
  await el('qqSave').events.click();
  assert.equal(calls.find(c=>c.command==='qq_save_config').args.request.token,'test-local-only');
  assert.equal(el('qqToken').value,'');assert.equal(el('qqEnabled').checked,true);assert.equal(el('qqSave').disabled,false);
});
test('QQ config failures stay local without exposing raw errors',async()=>{
  const {el}=mount(async()=>{throw Error('credential-secret');});
  await el('qqSave').events.click();assert.match(el('qqStatus').textContent,/保存失败/);assert.doesNotMatch(el('qqStatus').textContent,/credential-secret/);assert.equal(el('qqSave').disabled,false);
});
test('one QQ switch immediately saves and starts, then stops despite invalid unsaved fields',async()=>{
  const calls=[];let enabled=false,finish;
  const {el}=mount(async(command,args)=>{
    calls.push({command,args});
    if(command==='qq_save_config'){await new Promise(resolve=>{finish=resolve;}); enabled=args.request.enabled;}
    if(command==='qq_stop_service') enabled=false;
    if(command==='qq_get_config')return {enabled,hasToken:true,status:enabled?'connecting':'disabled',service:enabled?'managed':'stopped',login:'waiting-login'};
  });
  el('qqOwnerId').value='12345678';el('qqBotId').value='87654321';el('qqNickname').value='主人';
  el('qqWsUrl').value='ws://127.0.0.1:3001';el('qqEnabled').checked=true;
  const starting=el('qqEnabled').events.change();
  assert.equal(el('qqEnabled').disabled,true);assert.equal(el('qqSave').disabled,true);
  assert.equal(el('qqReplyMode').disabled,true);assert.equal(el('qqVoiceInput').disabled,true);
  assert.equal(calls[0].command,'qq_save_config');assert.equal(calls[0].args.request.enabled,true);
  finish();await starting;
  assert.equal(el('qqEnabled').checked,true);assert.equal(el('qqEnabled').disabled,false);
  assert.match(el('qqServiceStatus').textContent,/登录/);
  el('qqBotId').value='invalid unsaved edit';el('qqEnabled').checked=false;
  await el('qqEnabled').events.change();
  assert.equal(calls.filter(c=>c.command==='qq_stop_service').length,1);
  assert.equal(el('qqBotId').value,'invalid unsaved edit');assert.equal(el('qqEnabled').checked,false);
});
test('failed QQ switch restores actual state, permits retry and never displays raw errors',async()=>{
  let fail=true;let enabled=false;
  const {el}=mount(async(command,args)=>{
    if(command==='qq_save_config'){if(fail)throw 'napcat-missing';enabled=args.request.enabled;}
    if(command==='qq_get_config')return {enabled,service:'stopped',status:'disabled'};
  });
  el('qqEnabled').checked=true;await el('qqEnabled').events.change();
  assert.equal(el('qqEnabled').checked,false);assert.equal(el('qqEnabled').disabled,false);
  assert.match(el('qqServiceStatus').textContent,/NapCat/);
  fail=false;el('qqEnabled').checked=true;await el('qqEnabled').events.change();
  assert.equal(el('qqEnabled').checked,true);
});
test('login QR appears only while awaiting login and stale refresh cannot re-enable QQ',async()=>{
  let reads=0,release;
  const {el,refresh}=mount(async(command)=>{
    if(command==='qq_get_config'){
      reads++;
      if(reads===1)return {enabled:true,service:'managed',status:'connecting',login:'waiting-login',qrDataUrl:'data:image/svg+xml;base64,PHN2Zy8+'};
      if(reads===2)return await new Promise(resolve=>{release=resolve;});
      return {enabled:false,service:'stopped',status:'disabled'};
    }
  });
  await refresh();assert.equal(el('qqLoginQr').hidden,false);assert.match(el('qqServiceStatus').textContent,/扫描/);
  const stale=refresh();el('qqEnabled').checked=false;await el('qqEnabled').events.change();
  assert.equal(el('qqLoginQr').hidden,true);assert.equal(el('qqLoginQr').src,'');
  release({enabled:true,status:'connecting',service:'managed',login:'waiting-login',qrDataUrl:'https://untrusted.invalid/qr'});await stale;
  assert.equal(el('qqEnabled').checked,false);assert.equal(el('qqLoginQr').hidden,true);
});

test('QQ binding display follows saved desktop scope on every refresh, preserving unsaved transport fields',async()=>{
  let nickname='ππ',cardId='';
  const {el,refresh}=mount(async()=>({enabled:true,status:'connected',nickname,cardId}));
  await refresh();
  assert.equal(el('qqNickname').value,'ππ');
  el('qqOwnerId').value='unsaved owner';
  nickname='元宝';cardId='new-card';await refresh();
  assert.equal(el('qqNickname').value,'元宝');
  assert.equal(el('qqCardId').value,'new-card');
  assert.equal(el('qqOwnerId').value,'unsaved owner');
});
test('QQ media preferences save and reload without exposing credentials',async()=>{
  let saved;
  const {el}=mount(async(command,args)=>{
    if(command==='qq_save_config')saved=args.request;
    if(command==='qq_get_config')return {enabled:false,replyMode:'voice',voiceInput:true,mediaStatus:'ready'};
  });
  el('qqReplyMode').value='voice';el('qqVoiceInput').checked=true;
  await el('qqSave').events.click();
  assert.equal(saved.replyMode,'voice');assert.equal(saved.voiceInput,true);
  el('qqReplyMode').value='text';el('qqVoiceInput').checked=false;
  await el('qqRefresh').events.click();
  assert.equal(el('qqReplyMode').value,'voice');assert.equal(el('qqVoiceInput').checked,true);
});

test('experimental QQ phone preference persists and reports missing native prerequisites',async()=>{
  let saved;
  const {el,refresh}=mount(async(command,args)=>{
    if(command==='qq_save_config')saved=args.request;
    if(command==='qq_get_config')return {enabled:true,phoneEnabled:true,phoneStatus:'phone-setup-required'};
  });
  el('qqPhoneEnabled').checked=true;
  await el('qqSave').events.click();
  assert.equal(saved.phoneEnabled,true);
  await refresh();assert.equal(el('qqPhoneEnabled').checked,true);
  assert.match(el('qqPhoneStatus').textContent,/安装|音频/);
});
test('QQ phone audio-route failure gives an actionable message while ordinary QQ remains enabled',async()=>{
  const {el,refresh}=mount(async(command)=>command==='qq_get_config'
    ? {enabled:true,phoneEnabled:true,phoneStatus:'phone-audio-route-unavailable',status:'connected'}:undefined);
  await refresh();
  assert.equal(el('qqEnabled').checked,true);
  assert.match(el('qqPhoneStatus').textContent,/虚拟音频/);
  assert.match(el('qqPhoneStatus').textContent,/消息/);
});
