export type ConversationMessage = {
 id?: string;
 role: string;
 content: string;
 timestamp?: number;
 title?: string;
 hidden?: boolean;
 position?: number;
 images?: Array<{url:string;thumbnail?:string}>;
};
/** Complete pages win over the operational text-only copy. The reactive
 * operational tail keeps a just-sent reply visible before the next GET. */
export function mergeConversationHistory(history: ConversationMessage[], tail: ConversationMessage[]): ConversationMessage[] {
 const result=new Map<string,ConversationMessage>();
 const covered=new Set(history.flatMap(message=>(message.id??"").split("-&-")));
 const oldest=history.length?Math.min(...history.map(message=>message.timestamp??0)):0;
 const recentTail=tail.filter(message=>(message.timestamp??0)>=oldest && (!message.id || !covered.has(message.id)));
 for(const message of [...recentTail,...history]){
  const key=message.id??JSON.stringify([message.role,message.timestamp,message.content]);
  if(message.hidden)result.delete(key);else result.set(key,message);
 }
 return [...result.values()].sort((a,b)=>(a.timestamp??0)-(b.timestamp??0)||((a.position??1e9)-(b.position??1e9))||(a.id??"").localeCompare(b.id??""));
}
