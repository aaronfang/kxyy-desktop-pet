// Desktop-only QQ rhythm. No synthetic user turns, persisted text or random timers.
export function parseQqRhythm(raw) {
  const value=String(raw||'');
  const tags=[...value.matchAll(/\[会话[:：]([^\]\n]{0,40})\]/gu)];
  const text=value.replace(/\[会话[:：][^\]\n]{0,40}\]/gu,'').trim();
  const states={展开:'open',等待:'wait',结束:'closed'};
  let rhythm=tags.length===1?(states[tags[0][1].trim()]||'closed'):'closed';
  // A concrete question should leave room for its answer even if a model asks to continue.
  if(/[?？]\s*$/u.test(text))rhythm='wait';
  if(/(?:晚安|先不聊|回头聊|你先忙|不打扰)/u.test(text))rhythm='closed';
  return {text,rhythm};
}
export function createQqInbox({receive,now=()=>Date.now(),setTimer=setTimeout,clearTimer=clearTimeout}) {
  let timer=null,pending=null,started=0;
  const clear=()=>{if(timer!==null)clearTimer(timer);timer=null;pending=null;started=0;};
  async function flush(){const event=pending;clear();if(event)await receive(event);}
  return {clear,offer(event){
    if(!event)return;
    if(!pending)started=now();
    pending=event;
    if(timer!==null)clearTimer(timer);
    if(event.imageCount>0 || /请记住/u.test(event.text) || event.sourceCount>=8)return flush();
    timer=setTimer(flush,Math.max(0,Math.min(2500,8000-(now()-started))));
  }};
}
