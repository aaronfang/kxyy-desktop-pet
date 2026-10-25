import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
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
test('QQ config failures stay local; current binding is copied explicitly',async()=>{
  const {el}=mount(async()=>{throw Error('credential-secret');});
  el('personaCardId').value='custom';el('userName').value='主人';await el('qqBindCurrent').events.click();
  assert.equal(el('qqCardId').value,'custom');assert.equal(el('qqNickname').value,'主人');
  await el('qqSave').events.click();assert.match(el('qqStatus').textContent,/保存失败/);assert.doesNotMatch(el('qqStatus').textContent,/credential-secret/);assert.equal(el('qqSave').disabled,false);
});
