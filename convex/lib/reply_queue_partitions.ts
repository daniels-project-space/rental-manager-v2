type Account={_id:unknown;slug:string};
type ScopedRow={account_slug?:string;account_id?:unknown};
/** The null cohort retains legacy/unassigned threads rather than losing them
 * when their original account is missing from today's configured accounts. */
export function replyPartitionKey(row:ScopedRow,accounts:Account[]):string|null {
  const slug=row.account_slug??accounts.find(a=>String(a._id)===String(row.account_id))?.slug;
  return slug&&accounts.some(a=>a.slug===slug)?slug:null;
}
type QueueRow={thread_id:string;is_request:boolean;last_sender?:string|null;last_renter_msg_at?:number|null;last_msg_at?:number|null;last_activity_at?:number|null};
export function compareReplyQueue(a:QueueRow,b:QueueRow){
  if(a.is_request!==b.is_request)return Number(b.is_request)-Number(a.is_request);
  const aAwait=a.last_sender==="renter",bAwait=b.last_sender==="renter";
  if(aAwait!==bAwait)return Number(bAwait)-Number(aAwait);
  return aAwait?(a.last_renter_msg_at??0)-(b.last_renter_msg_at??0):(b.last_msg_at??0)-(a.last_msg_at??0);
}
export function mergeReplyPartitions<T extends QueueRow>(parts:T[][],limit:number):T[]{
  const rows=new Map<string,T>();
  for(const part of parts)for(const row of part){const prior=rows.get(row.thread_id);if(!prior||(row.last_activity_at??0)>(prior.last_activity_at??0))rows.set(row.thread_id,row);}
  return [...rows.values()].sort(compareReplyQueue).slice(0,limit);
}
