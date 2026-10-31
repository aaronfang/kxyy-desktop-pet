import { sanitizeObservationText } from './observation.js';

export const MEMORY_TIME_RULE = '历史记录不代表当前状态；相对日期以原消息日期为准，时间未知就说“之前”。计划没有完成证据不能当作已发生。';
const labels={fact:'事实',episode:'经历',commitment:'约定'};
function dateParts(value,timeZone='Asia/Shanghai') {
  const date=value instanceof Date ? value : new Date(Number(value)*1000);
  if(!Number.isFinite(date.getTime())) return null;
  try {
    const parts=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date);
    const p=type=>parts.find(x=>x.type===type)?.value;
    return {date:`${p('year')}-${p('month')}-${p('day')}`,time:`${p('hour')}:${p('minute')}`};
  } catch{return null;}
}
function validDay(value) {
  return typeof value==='string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value+'T12:00:00Z')) && new Date(value+'T12:00:00Z').toISOString().slice(0,10)===value;
}
export function memoryTimeText(item,now=new Date()) {
  const text=sanitizeObservationText(item?.text??item?.content,{maxChars:600});
  if(!text)return '';
  const temporal=item.temporal||{},zone=temporal.timeZone||'Asia/Shanghai',tags=[labels[item.kind]||'记忆'];
  if(validDay(temporal.eventDate)) {
    const today=dateParts(now,zone)?.date;
    const days=today ? Math.round((Date.parse(today)-Date.parse(temporal.eventDate))/86400000) : null;
    const relative=days===0?'今天':days===1?'昨天':days===-1?'明天':days===null?'':days>0?`${days}天前`:`${-days}天后`;
    tags.push(`事件日期:${temporal.eventDate}${relative?`（${relative}）`:''}`);
  } else tags.push('发生时间未知');
  if(temporal.tense==='planned')tags.push('计划，未证明已经完成');
  else if(temporal.tense==='past')tags.push('历史事件，不代表当前状态');
  else if(temporal.tense==='current')tags.push('仅在原消息当时的状态，当前需确认');
  const message=dateParts(temporal.messageAt,zone);
  if(message && Number(temporal.messageAt)>0) tags.push(`提及:${message.date} ${message.time}`);
  else if(Number(item.occurredAt)>0) {
    const legacy=dateParts(item.occurredAt,zone);
    if(legacy)tags.push(`${item.kind==='commitment'?'约定到期':item.kind==='fact'?'生效日期，非事件发生':'旧记录日期，非已核实发生时间'}:${legacy.date}`);
  }
  return `[${tags.join('；')}] ${text}`;
}
export function formatTemporalHistory(history,{timeZone='Asia/Shanghai'}={}) {
  return (Array.isArray(history)?history:[]).map(message=>{
    const at=Number(message.messageAt)>0 ? dateParts(message.messageAt,timeZone) : null;
    const marker=at?`${at.date} ${at.time}（${timeZone}）`:'消息时间未知，不将相对日期视为今天';
    return {role:message.role,content:`[原消息时间:${marker}]\n${message.content||''}`};
  });
}
