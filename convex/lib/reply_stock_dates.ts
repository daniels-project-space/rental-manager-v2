import { validIsoDate, shiftStockDate } from "./renter_stock";

export type ReplyStockWindow = {
  start_date: string;
  end_date: string;
  source: "booking" | "chat" | "today";
  message_id?: string;
  note?: string;
  pickup_time?: string;
  return_time?: string;
};
type Message = { sender: string; body_text?: string; hygglo_sent_at?: number; message_id?: string };
const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const weekdays = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const monthPattern = "Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?";
const iso = (year: number, month: number, day: number) => `${year}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
export const londonReplyDate = (at: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year:"numeric",month:"2-digit",day:"2-digit" }).format(at);
type Mention = { start: string; end?: string; index: number; length: number };

/** Read renter proposals only. Never use listing descriptions, owner holiday
 * dates, ingestion time or today's clock to reinterpret an old "tomorrow". */
export function replyDatesFromMessage(message: Message): ReplyStockWindow | null {
  if (message.sender !== "renter" || !message.body_text) return null;
  const text = message.body_text.replace(/[–—]/g,"-");
  const stamp = message.hygglo_sent_at;
  const reference = typeof stamp === "number" && Number.isFinite(stamp) && stamp > 0 ? londonReplyDate(stamp) : null;
  const year = reference ? Number(reference.slice(0,4)) : null;
  const found: Mention[] = [];
  const add = (start:string,end:string|undefined,index:number,length:number) => {
    if (!validIsoDate(start) || end && (!validIsoDate(end) || end < start)) return;
    if (found.some(m=>index < m.index+m.length && index+length > m.index)) return;
    found.push({start,end,index,length});
  };
  for (const m of text.matchAll(/\b(20\d{2}-\d{2}-\d{2})(?:\s*(?:to|until|through|-)\s*(20\d{2}-\d{2}-\d{2}))?\b/g)) add(m[1],m[2],m.index!,m[0].length);
  for (const m of text.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/g)) add(iso(Number(m[3]),Number(m[2]),Number(m[1])),undefined,m.index!,m[0].length);
  for (const m of text.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:(?:to|until|through|-)\\s*(\\d{1,2})(?:st|nd|rd|th)?\\s*)?(${monthPattern})(?:\\s+(20\\d{2}))?\\b`,"gi"))) {
    const y=m[4]?Number(m[4]):year;if(!y)continue;
    const month=months.indexOf(m[3].toLowerCase().slice(0,3))+1;
    add(iso(y,month,Number(m[1])),m[2]?iso(y,month,Number(m[2])):undefined,m.index!,m[0].length);
  }
  for (const m of text.matchAll(new RegExp(`\\b(${monthPattern})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(20\\d{2}))?\\b`,"gi"))) {
    const y=m[3]?Number(m[3]):year;if(!y)continue;
    add(iso(y,months.indexOf(m[1].toLowerCase().slice(0,3))+1,Number(m[2])),undefined,m.index!,m[0].length);
  }
  // "29 October ... return on the 30th": inherit only the explicitly named
  // month, only for a return clause. Do not read money, times or model numbers.
  const first=found.sort((a,b)=>a.index-b.index)[0];
  if(first)for(const m of text.matchAll(/\b(?:return|drop\s*off)\b[^.!?\n]{0,45}?\b(\d{1,2})(?:st|nd|rd|th)\b/gi)) {
    const day=Number(m[1]);let d=first.start.slice(0,8)+String(day).padStart(2,"0");
    if(d<first.start){const next=new Date(first.start+"T12:00Z");next.setUTCMonth(next.getUTCMonth()+1,day);d=next.toISOString().slice(0,10);}
    add(d,undefined,m.index!,m[0].length);
  }
  if(reference){
    for(const m of text.matchAll(/\b(today|tonight|tomorrow)\b/gi))add(shiftStockDate(reference,m[1].toLowerCase()==="tomorrow"?1:0),undefined,m.index!,m[0].length);
    for(const m of text.matchAll(/\b(next\s+)?(mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)(?:\s+(\d{1,2})(?:st|nd|rd|th))?\b/gi)){
      // A weekday adjoining an explicit calendar date is a label, not a
      // second independent proposal for the nearest occurrence of that day.
      if(found.some(d=>d.index>=m.index! && d.index<=m.index!+m[0].length+2))continue;
      const target=weekdays.indexOf(m[2].toLowerCase().slice(0,3));
      const weekday=new Date(reference+"T12:00Z").getUTCDay();
      let delta=(target-weekday+7)%7;if(m[1]&&delta===0)delta=7;
      const d=shiftStockDate(reference,delta);
      if(m[3]&&Number(d.slice(8))!==Number(m[3]))continue;
      add(d,undefined,m.index!,m[0].length);
    }
  }
  if(!found.length)return null;
  found.sort((a,b)=>a.index-b.index);
  // Repeated references to the same date ("tomorrow, 15 Oct") are evidence
  // for one date, not a two-day span. Unrelated alternatives stay unresolved.
  const distinct=[...new Set(found.flatMap(m=>[m.start,...m.end?[m.end]:[]]))];
  if(distinct.length>2)return null;
  if(distinct.length>1 && /\bor\b/i.test(text.slice(found[0].index,found.at(-1)!.index)))return null;
  let start=distinct[0],end=distinct[1]??found[0].end??start;
  const role=(m:Mention)=>{
    const prefix=text.slice(Math.max(0,m.index-100),m.index+m.length);
    const roles=[...prefix.matchAll(/\b(collection|collect|pick\s*up|pickup|return|drop\s*off)\b/gi)];
    const last=roles.at(-1);if(!last)return null;
    // Do not carry a logistics word across an unrelated sentence.
    if(/[.!?\n]/.test(prefix.slice(last.index!+last[0].length)))return null;
    return /return|drop/i.test(last[0])?"return":"pickup";
  };
  const pickup=found.find(m=>role(m)==="pickup"),returned=found.find(m=>role(m)==="return");
  if(pickup&&returned){start=pickup.start;end=returned.end??returned.start;}
  const returnNext=/\b(?:return|drop\s*off)\b[^.!?\n]{0,35}\b(?:next|following) day\b/i.test(text);
  if(distinct.length===1&&returnNext)end=shiftStockDate(start,1);
  if(end<start){
    // Forward weekday ranges can cross a week boundary; absolute reversed
    // dates are never silently reordered.
    if(found.every(m=>/^(?:next\s+)?(?:mon|tue|wed|thu|fri|sat|sun)/i.test(text.slice(m.index))))end=shiftStockDate(end,7);
    else return null;
  }
  if((Date.parse(end)-Date.parse(start))/86400000>366)return null;
  const clocks:{pickup_time?:string;return_time?:string}={};
  for(const m of text.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/gi)){
    const hour=Number(m[1]),minute=Number(m[2]??0);if(hour<1||hour>12||minute>59)continue;
    const prefix=text.slice(Math.max(0,m.index!-100),m.index!);
    const roles=[...prefix.matchAll(/\b(pick(?:\s+(?:it|them))?\s*up|pickup|collect|collection|return|drop\s*off)\b/gi)];
    const last=roles.at(-1);if(!last||/[.!?\n]/.test(prefix.slice(last.index!+last[0].length)))continue;
    const clock=`${String(hour%12+(m[3].toLowerCase()==="pm"?12:0)).padStart(2,"0")}:${String(minute).padStart(2,"0")}`;
    if(/return|drop/i.test(last[0]))clocks.return_time=clock;else clocks.pickup_time=clock;
  }
  // An impossible same-day clock pair cannot certify a positive stock window.
  if(start===end&&clocks.pickup_time&&clocks.return_time&&clocks.return_time<=clocks.pickup_time)return null;
  return {start_date:start,end_date:end,source:"chat",...clocks,...(message.message_id?{message_id:message.message_id}:{}),note:"Dates requested in chat; no booking has been changed"};
}

export function replyStockWindow(booking: { start_date?:string; end_date?:string; pickup_date?:string; return_date?:string } | null, messages: Message[], now: number): ReplyStockWindow {
  if(booking?.start_date && booking.end_date && validIsoDate(booking.start_date) && validIsoDate(booking.end_date))
    return {start_date:booking.pickup_date??booking.start_date,end_date:booking.return_date??booking.end_date,source:"booking"};
  for(const message of [...messages].sort((a,b)=>(b.hygglo_sent_at??0)-(a.hygglo_sent_at??0))){
    const dates=replyDatesFromMessage(message);if(dates)return dates;
    // A new but contradictory date proposal must not resurrect an older quote.
    if(message.sender==="renter"&&/\b(?:rent|book|need|actually|instead|change)\b/i.test(message.body_text??"")&&new RegExp(`\\b(?:${monthPattern}|tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\\b`,"i").test(message.body_text??""))break;
  }
  const today=londonReplyDate(now);
  return {start_date:today,end_date:today,source:"today",note:"No rental dates were supplied. This checks today's stock only; future hire availability is not confirmed."};
}
