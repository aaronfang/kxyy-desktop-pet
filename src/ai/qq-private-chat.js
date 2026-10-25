import { sanitizeObservationText } from "./observation.js";
// Desktop-only QQ pipeline. No desktop history, audio, tools or memory writes.
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
export function createQqPrivateChat({getScope,recall,buildSystem,generate,send,claim=async()=>true,timeoutMs=30000}) {
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
    const timer=setTimeout(()=>controller.abort(),timeoutMs);
    const current=()=>active===controller && !controller.signal.aborted && sameScope(scope,getScope()||{});
    try {
      const lease=await abortable(claim(event.nonce),controller.signal);
      if(!lease || !current()) return 'cancelled';
      if(historyLease!==lease) history=[];
      historyLease=lease;
      let items=[];
      try {const result=await abortable(recall(event.text,scope),controller.signal);items=Array.isArray(result)?result:result?.items||[];} catch(_) {if(!current()) return 'cancelled';}
      if(!current()) return 'cancelled';
      const memory=clip((Array.isArray(items)?items:[]).slice(0,6).map(i=>sanitizeObservationText(i?.text??i?.content,{maxChars:500})).filter(Boolean).join('\n'),500);
      const system=buildSystem(scope);
      const text=clip((await abortable(generate({system,memory,history:history.map(x=>({...x})),text:event.text,signal:controller.signal}),controller.signal)),2000).trim();
      if(!current() || !text) return 'cancelled';
      const outcome=await abortable(send(event.nonce,text),controller.signal);
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
