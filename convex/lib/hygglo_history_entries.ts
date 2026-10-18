import { parseCreatedAtLabel } from "../../src/hygglo-core/shape";
export type HistoryEntry = {
  id: string;
  role: "owner" | "renter" | "system";
  content: string;
  title?: string;
  hidden?: boolean;
  position?: number;
  timestamp?: number;
  images: Array<{url: string; thumbnail?: string}>;
};
function https(value: unknown): string | undefined {
  if(typeof value!=="string")return;
  try { return new URL(value).protocol === "https:" ? value : undefined; } catch { return; }
}
/** Preserve the complete visible timeline separately from operational chat.
 * Provider status events never become renter input or unread notifications. */
export function hyggloHistoryEntries(detail: {activities?: any[]}): HistoryEntry[] {
  return (detail.activities ?? []).flatMap((activity,position): HistoryEntry[] => {
    if(typeof activity.key!=="string" || !activity.key)return [];
    const chat=activity.chatMessage;
    if(chat?.hidden===true)return [{id:activity.key,position,role:chat.byMe?"owner":"renter",content:"",images:[],hidden:true}];
    const text=chat?.text?.content;
    const event=activity.event;
    const url=https(chat?.image?.urls?.full), thumbnail=https(chat?.image?.urls?.thumbnail);
    const content=typeof text==="string"?text:typeof event?.content==="string"?event.content:"";
    if(!content.trim()&&!url)return [];
    const timestamp=parseCreatedAtLabel(activity.createdAtLabel??"")?.getTime();
    return [{id:activity.key,position,role:chat?(chat.byMe?"owner":"renter"):"system",content,
      ...(typeof event?.title==="string"?{title:event.title}:{}),
      ...(timestamp!==undefined?{timestamp}:{}),images:url?[{url,...(thumbnail?{thumbnail}:{})}]:[]}];
  }).sort((a,b)=>(a.timestamp??0)-(b.timestamp??0)||(a.position??0)-(b.position??0));
}
