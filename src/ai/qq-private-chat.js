import { sanitizeObservationText } from "./observation.js";
import { explicitMemoryText } from "./memory-experience.js";
// Owner-bound QQ pipeline. Desktop memory scope, separate short history, no desktop tools.
const clip = (s,n) => [...String(s || '')].slice(0,n).join('');
const sameScope = (a,b) => a.cardId===b.cardId && a.nickname===b.nickname && a.epoch===b.epoch;
function abortable(promise, signal) {
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(new Error('cancelled'));
    if(signal.aborted) return abort();
    signal.addEventListener('abort',abort,{once:true});
    Promise.resolve(promise).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  });
}
export function createQqPrivateChat({getScope,recall,buildSystem,generate,send,remember=async()=>null,claim=async()=>true,cancel=()=>{},timeoutMs=30000,deliveryTimeoutMs=245000}) {
  let active=null;
  const nonces=[];
  let history=[];
  let historyScope=null;
  let historyLease=null;
  function invalidate({clearHistory=true}={}) {
    active?.abort(); active=null;
    if(clearHistory) {history=[];historyScope=null;historyLease=null;}
  }
  async function receive(event) {
    const scope=getScope();
    if(!scope || !event || typeof event.text!=='string' || !event.text.trim() || [...event.text].length>2000
      || typeof event.nonce!=='string' || !event.nonce || event.nonce.length>80
      || event.cardId!==scope.cardId || event.nickname!==scope.nickname) return 'ignored';
    if(nonces.includes(event.nonce)) return 'ignored';
    nonces.push(event.nonce);if(nonces.length>32) nonces.shift();
    invalidate({clearHistory:false});
    if(!historyScope || !sameScope(historyScope,scope)) history=[];
    historyScope={...scope};
    const controller=new AbortController();active=controller;
    let timer=setTimeout(()=>controller.abort(),timeoutMs);
    controller.signal.addEventListener("abort",()=>{void Promise.resolve().then(()=>cancel(event.nonce)).catch(()=>{});},{once:true});
    const deliver=(text)=>{
      clearTimeout(timer);timer=setTimeout(()=>controller.abort(),deliveryTimeoutMs);
      return abortable(send(event.nonce,text),controller.signal);
    };
    const current=()=>active===controller && !controller.signal.aborted && sameScope(scope,getScope()||{});
    try {
      const lease=await abortable(claim(event.nonce),controller.signal);
      if(!lease || !current()) return 'cancelled';
      if(historyLease!==lease) history=[];
      historyLease=lease;
      if(explicitMemoryText(event.text)) {
        let receipt;
        try {receipt=await abortable(remember(event.nonce),controller.signal);} catch(_) {}
        if(!current()) return 'cancelled';
        const reply=receipt?.stored===true ? '已保存到长期记忆。' : '这条未保存到长期记忆（内容可能不符合保存条件，或存储暂不可用），请检查后重试。';
        // Explicit requests and receipts never become automatic extraction evidence.
        return await deliver(reply);
      }
      let items=[];
      try {const result=await abortable(recall(event.text,scope,{signal:controller.signal,isCurrent:current,history:history.map(x=>({...x}))}),controller.signal);items=Array.isArray(result)?result:result?.items||[];} catch(_) {if(!current()) return 'cancelled';}
      if(!current()) return 'cancelled';
      const memory=clip((Array.isArray(items)?items:[]).slice(0,6).map(i=>sanitizeObservationText(i?.text??i?.content,{maxChars:500})).filter(Boolean).join('\n'),500);
      const system=buildSystem(scope,{
        replyMode:event.replyMode==='voice'?'voice':'text',
        voiceInput:event.voiceInput===true,
      });
      const text=clip((await abortable(generate({system,memory,history:history.map(x=>({...x})),text:event.text,signal:controller.signal}),controller.signal)),2000).trim();
      if(!current() || !text) return 'cancelled';
      const outcome=await deliver(text);
      if(current() && outcome==='sent') {
        history.push({role:'user',content:clip(event.text,2000)},{role:'assistant',content:text});
        history=history.slice(-8);
      }
      return outcome;
    } catch(_) {return current()?'failed':'cancelled';}
    finally {clearTimeout(timer);if(active===controller) active=null;}
  }
  return {receive,invalidate};
}
