import { parseQqRhythm } from "./qq-rhythm.js";
import { memoryTimeText } from "./memory-time.js";
import { extractSticker } from "./stickers.js";
import { sanitizeObservationText } from "./observation.js";
import { hasDirectWebSearchIntent } from "./web-observations.js";
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
export function createQqPrivateChat({getScope,recall,buildSystem,generate,send,remember=async()=>null,decideSearch=null,observe=async()=>[],readImages=async()=>[],claim=async()=>true,cancel=()=>{},timeoutMs=30000,imageTimeoutMs=60000,searchTimeoutMs=65000,deliveryTimeoutMs=245000,planInitiative=null,getBusy=()=>false,getInitiativeHistory=null,decline=async()=>{},now=()=>Date.now()}) {
  let active=null;
  const nonces=[];
  let history=[];
  let historyScope=null;
  let historyLease=null;
  let historyVersion=0;
  let settling=null;
  // One confirmed outgoing share, for the immediate reply only. Never put
  // source data into ordinary history, recall planning or long-term Memory.
  let recentShare=null;
  function invalidate({clearHistory=true}={}) {
    active?.abort(); active=null;
    if(clearHistory) {historyVersion++;history=[];historyScope=null;historyLease=null;recentShare=null;}
  }
  async function receive(event) {
    const scope=getScope();
    const sources=Array.isArray(event?.sourceMessages) && event.sourceMessages.length<=8 && event.sourceMessages.every(m=>m?.role==='user'&&typeof m.content==='string'&&[...m.content].length<=2000)
      ? event.sourceMessages.map(m=>({role:'user',content:m.content,messageAt:Number(m.messageAt)>0?Number(m.messageAt):null})):[];
    if(!scope || !event || typeof event.text!=='string' || !event.text.trim() || [...event.text].length>Math.max(1,sources.length)*2000+Math.max(0,sources.length-1)
      || typeof event.nonce!=='string' || !event.nonce || event.nonce.length>80
      || event.cardId!==scope.cardId || event.nickname!==scope.nickname) return 'ignored';
    if(nonces.includes(event.nonce)) return 'ignored';
    nonces.push(event.nonce);if(nonces.length>32) nonces.shift();
    invalidate({clearHistory:false});
    if(!historyScope || !sameScope(historyScope,scope)) history=[];
    historyScope={...scope};
    const controller=new AbortController();active=controller;
    // Up to three authenticated downloads plus visual captions; still below
    // the native lease even with the 100-second voice synthesis budget.
    let timer=setTimeout(()=>controller.abort(),event.imageCount>0 ? imageTimeoutMs : timeoutMs);
    const version=historyVersion;
    controller.signal.addEventListener("abort",()=>{void Promise.resolve().then(()=>cancel(event.nonce)).catch(()=>{});},{once:true});
    const deliver=(text,attachments,external=false)=>{
      clearTimeout(timer);timer=setTimeout(()=>controller.abort(),deliveryTimeoutMs);
      const delivery=Promise.resolve(external ? send(event.nonce,text,attachments,{external:true}) : attachments ? send(event.nonce,text,attachments) : send(event.nonce,text));
      settling=delivery.catch(()=>null);
      return abortable(delivery,controller.signal);
    };
    const current=()=>active===controller && !controller.signal.aborted && sameScope(scope,getScope()||{});
    try {
      if(settling) {
        let drainTimer;
        try {await abortable(Promise.race([settling,new Promise(resolve=>{drainTimer=setTimeout(resolve,2500);})]),controller.signal);}
        finally {clearTimeout(drainTimer);}
      }
      const lease=await abortable(claim(event.nonce),controller.signal);
      if(!lease || !current()) return 'cancelled';
      // An initiative may be the first turn in this scope. Adopt the first
      // authenticated lease without dropping its confirmed assistant message;
      // subsequent lease changes still discard the old conversation.
      if(historyLease!==null && historyLease!==lease) {history=[];recentShare=null;}
      historyLease=lease;
      if(recentShare && (now()<recentShare.at || now()-recentShare.at>=10*60*1000 || !sameScope(recentShare.scope,scope)))recentShare=null;
      if(/换个话题|聊点别的|记得|回忆|上次|(?:之前|以前).{0,12}(?:聊|说|提|约)/u.test(event.text))recentShare=null;
      const share=recentShare;
      const shareContext=share?{text:share.text,messageAt:Math.floor(share.at/1000)}:null;
      if(event.text.includes('[暂不支持的视频附件]')) return await deliver('视频理解还未开启，请先发送图片或文字。');
      const imageCount=Number.isSafeInteger(event.imageCount) ? event.imageCount : 0;
      if(imageCount>3) return await deliver('一条消息最多识别 3 张图片，请分开发送。');
      if(imageCount>0 && explicitMemoryText(event.text)) return await deliver('这条未保存到长期记忆。请单独发送文字「请记住：…」，写明你希望保存的事实，避免误存图片推测。');
      let images=[];
      if(imageCount>0) {
        try {
          images=await abortable(readImages(event.nonce),controller.signal);
          if(!Array.isArray(images) || images.length!==imageCount || images.some(x=>typeof x!=='string'||!/^data:image\/(png|jpeg);base64,/.test(x)||x.length>3*1024*1024)) throw Error('images');
        } catch(_) {
          if(!current()) return 'cancelled';
          return await deliver('图片暂时读取失败，请重新发送较小的图片，或改用文字描述。');
        }
        if(!current()) return 'cancelled';
      }
      if(explicitMemoryText(event.text) && !images.length) {
        let receipt;
        try {receipt=await abortable(remember(event.nonce),controller.signal);} catch(_) {}
        if(!current()) return 'cancelled';
        const reply=receipt?.stored===true ? '已保存到长期记忆。' : '这条未保存到长期记忆（内容可能不符合保存条件，或存储暂不可用），请检查后重试。';
        // Explicit requests and receipts never become automatic extraction evidence.
        return await deliver(reply);
      }
      let items=[];
      try {if(!shareContext){const result=await abortable(recall(event.text,scope,{signal:controller.signal,isCurrent:current,history:history.map(x=>({...x}))}),controller.signal);items=Array.isArray(result)?result:result?.items||[];}} catch(_) {if(!current()) return 'cancelled';}
      if(!current()) return 'cancelled';
      const memory=clip((Array.isArray(items)?items:[]).slice(0,6).map(i=>memoryTimeText(i)).filter(Boolean).join('\n'),500);
      let searchPlan=null;
      if(decideSearch) {
        try {searchPlan=await abortable(decideSearch({query:event.text,sourceMessages:sources,signal:controller.signal}),controller.signal);} catch(_) {if(!current()) return 'cancelled';}
        if(!current()) return 'cancelled';
      } else if(hasDirectWebSearchIntent(event.text)) searchPlan={query:event.text};
      const searchRequested=!!searchPlan?.query;
      const external=searchRequested || !!shareContext;
      let web=[];
      let webStatus=searchRequested?'provider_error':'not-requested';
      if(searchRequested) {
        clearTimeout(timer);timer=setTimeout(()=>controller.abort(),searchTimeoutMs);
        try {
          const result=await abortable(observe({query:searchPlan.query,signal:controller.signal}),controller.signal);
          web=Array.isArray(result)?result:Array.isArray(result?.items)?result.items:[];
          webStatus=web.length?'ok':Array.isArray(result)?'empty':['timeout','disabled','unconfigured','auth_error','rate_limited','quota_exceeded','invalid_response','empty'].includes(result?.status)?result.status:'provider_error';
        } catch(_) {if(!current()) return 'cancelled';}
        if(!current()) return 'cancelled';
      }
      const system=buildSystem(scope,{
        replyMode:event.replyMode==='voice'?'voice':'text',
        voiceInput:event.voiceInput===true,
      });
      let result;
      try {
        result=await abortable(generate({system,memory,history:shareContext?[]:history.map(x=>({...x})),shareContext,searchRequested,webStatus,text:event.text,sourceMessages:sources,images,web,external,signal:controller.signal}),controller.signal);
      } catch(error) {
        if(images.length && current()) return await deliver('图片暂时识别失败，请稍后重试，或改用文字描述。');
        throw error;
      }
      const text=clip(typeof result==='string'?result:result?.text,2000).trim();
      const details=searchRequested&&web.length?clip(result?.details,5500).trim():'';
      const attachments=details?{details}:typeof result==='object' && (result?.stickerFile || result?.face!=null)
        ? {stickerFile:result.stickerFile||null,face:result.face??null} : undefined;
      if(!current() || !text) return 'cancelled';
      const recordReceipt=receipt=>{
        const outcome=typeof receipt==='string'?receipt:receipt?.outcome;
        const confirmedText=typeof receipt==='object'?clip(receipt?.deliveredText,2000):outcome==='sent'?text:'';
        if(version===historyVersion && recentShare===share && ['sent','partial','unknown'].includes(outcome))recentShare=null;
        if(version===historyVersion && sameScope(scope,getScope()||{}) && historyLease===lease
          && ['sent','partial'].includes(outcome) && confirmedText && !external) {
          const deliveredText=event.replyMode==='voice' && attachments ? '（发送了一个表情）' : confirmedText;
          history.push(...(sources.length?sources:[{role:'user',content:clip(event.text,2000),messageAt:Number(event.messageAt)>0?Number(event.messageAt):null}]),{role:'assistant',content:deliveredText,messageAt:Math.floor(Date.now()/1000)});
          history=history.slice(-8);
        }
        return outcome;
      };
      // Native cancellation may return an already confirmed prefix after this
      // generation was aborted. Keep that receipt, never the proposed remainder.
      clearTimeout(timer);timer=setTimeout(()=>controller.abort(),deliveryTimeoutMs);
      const metadata=external?{external:true}:['open','wait'].includes(result?.rhythm)?{rhythm:result.rhythm}:null;
      const nativeDelivery=Promise.resolve(metadata?send(event.nonce,text,attachments,metadata):attachments?send(event.nonce,text,attachments):send(event.nonce,text));
      settling=nativeDelivery.then(recordReceipt,()=>null);
      return await abortable(settling,controller.signal);
    } catch(_) {return current()?'failed':'cancelled';}
    finally {clearTimeout(timer);if(active===controller) active=null;}
  }
  async function initiate(event) {
    const scope=getScope();
    if(!planInitiative || active || getBusy() || !scope || !event || event.cardId!==scope.cardId || event.nickname!==scope.nickname || typeof event.nonce!=='string' || !event.nonce || event.nonce.length>80 || typeof event.source!=='string' || event.source.length>1500 || nonces.includes(event.nonce)) return 'ignored';
    nonces.push(event.nonce);if(nonces.length>32)nonces.shift();
    const controller=new AbortController();active=controller;
    const version=historyVersion;
    const timer=setTimeout(()=>controller.abort(),20000);
    const current=()=>active===controller&&!controller.signal.aborted&&!getBusy()&&sameScope(scope,getScope()||{});
    controller.signal.addEventListener('abort',()=>{void Promise.resolve(cancel(event.nonce)).catch(()=>{});},{once:true});
    try {
      const source=sanitizeObservationText(event.source,{maxChars:700});
      if(!source)return 'silent';
      const proposal=await abortable(planInitiative({system:buildSystem(scope,{replyMode:event.replyMode==='voice'?'voice':'text',voiceInput:false}),history:(getInitiativeHistory?.(event)||history).map(x=>({...x})),source,kind:event.kind||"contact",signal:controller.signal}),controller.signal);
      if(!current())return 'cancelled';
      if(proposal?.action!=='send'){await decline(event.nonce,proposal?.action==='drop'?'drop':'wait');return 'silent';}
      if(['share','memory'].includes(event.kind) && (!Number.isInteger(proposal.score)||proposal.score<13||proposal.score>20)){
        await decline(event.nonce,'drop');return 'silent';
      }
      const text=clip(parseQqRhythm(proposal.text).text,600).trim();
      if(!text || /(?:不理我|怎么不回|怎么还不|你必须|你应该马上|刚刚我去|我刚去|我今天去了)/u.test(text)){await decline(event.nonce,'drop');return 'silent';}
      clearTimeout(timer);
      const delivery=Promise.resolve(send(event.nonce,text,undefined,{proactive:true,external:event.external===true,channel:event.channel}));
      // A new owner message may arrive before the ACK. Reconcile the confirmed
      // prefix even after cancellation, before that owner turn builds context.
      settling=delivery.then(receipt=>{
        const outcome=typeof receipt==='string'?receipt:receipt?.outcome;
        const delivered=typeof receipt==='object'?clip(receipt.deliveredText,600):outcome==='sent'?text:'';
        if(event.external===true && event.channel!=='desktop' && version===historyVersion && sameScope(scope,getScope()||{}) && ['sent','partial'].includes(outcome) && delivered){
          const safeText=sanitizeObservationText(delivered,{maxChars:600});
          history=[];historyScope={...scope};recentShare=safeText?{text:safeText,at:now(),scope:{...scope}}:null;
        }
        return receipt;
      },()=>null);
      const receipt=await abortable(settling,controller.signal);
      const outcome=typeof receipt==='string'?receipt:receipt?.outcome;
      if(current() && outcome==='sent' && !event.external && event.channel!=='desktop') {
        if(!historyScope||!sameScope(historyScope,scope))history=[];
        historyScope={...scope};
        history.push({role:'assistant',content:typeof receipt==='object'?receipt.deliveredText:text,messageAt:Math.floor(Date.now()/1000)});history=history.slice(-8);
      }
      return outcome||'failed';
    }catch(_){return current()?'failed':'cancelled';}
    finally{clearTimeout(timer);if(active===controller)active=null;void Promise.resolve(cancel(event.nonce)).catch(()=>{});}
  }
  return {receive,invalidate,initiate};
}

// Presentation remains data: no model-selected QQ actions, file paths or URLs.
export function qqReplyPresentation(raw,selectSticker=()=>null,requestText='') {
  const {text:withoutSticker,emotion}=extractSticker(raw);
  const faces={微笑:14,可爱:21,得意:4,流泪:5,呲牙:13,爱心:66,可怜:104};
  let face=null;
  const text=withoutSticker.replace(/\[QQ表情[:：]([^\]]+)\]/g,(_,name)=>{if(face===null)face=faces[name.trim()]??null;return '';}).trim();
  // Only direct, allow-listed presentation requests are deterministic. A
  // discussion of expressions, quoted stories or unknown names is not a command.
  const request=String(requestText);
  const blocked=/(?:别|不要|不用|禁止).{0,12}(?:表情|贴纸)/u.test(request);
  const requested=blocked ? null : request.match(/(?:^|[，,。！？!?；;\n])\s*(?:(?:请|再|你|给我|帮我|顺便|麻烦|能不能|可以|元元)\s*){0,4}(?:发|回|附|来|配|送)(?:复)?(?:给我|我|上)?(?:一下)?(?:一[个张]|[个张])?(微笑|可爱|得意|流泪|呲牙|爱心|可怜|卖萌|害羞|调皮|无语)?(?:的)?(?:QQ\s*)?(?:表情包?|贴纸)/u);
  const requestedName=requested?.[1];
  const selectedEmotion=requestedName && !(requestedName in faces) ? requestedName : emotion;
  const sticker=selectedEmotion ? selectSticker(selectedEmotion) : null;
  const stickerFile=typeof sticker?.file==='string' && /^[a-z0-9_-]+\.gif$/.test(sticker.file) ? sticker.file : null;
  if(blocked) return text;
  if(requestedName in faces) return {text:text||'😊',stickerFile:null,face:faces[requestedName]};
  if(requested && !stickerFile && face===null) face=14;
  if(!stickerFile && face===null) return text;
  return {text:text||'😊',stickerFile,face:stickerFile?null:face};
}
