/** The request actually reviewed by Native task persistence. The original
 * source stays as the audit anchor when an equivalent follow-up refreshes it. */
export function ownerCheckRequestMessageId(task:{source_message_id:string;last_requested_message_id?:string}) {
 return task.last_requested_message_id??task.source_message_id;
}
