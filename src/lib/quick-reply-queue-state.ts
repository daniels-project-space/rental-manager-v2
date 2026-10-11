export type QueueRow = { thread_id:string;last_renter_msg_at:number;last_sender:string|null;preview:string;last_activity_at:number;last_msg_at?:number };
export type ReplyReceipt = { through:number;at:number;text:string };

export function threadHidden(row:Pick<QueueRow,"last_renter_msg_at">, through:number|null|undefined) {
  return through != null && row.last_renter_msg_at <= through;
}
/** A confirmed operator send demotes the queue immediately; a new renter wins. */
export function applyReplyReceipt<T extends QueueRow>(row:T, receipt?:ReplyReceipt):T {
  if(!receipt || row.last_renter_msg_at>receipt.through || row.last_activity_at>receipt.at)return row;
  return {...row,last_sender:"owner",preview:receipt.text,last_activity_at:receipt.at,last_msg_at:receipt.at};
}
