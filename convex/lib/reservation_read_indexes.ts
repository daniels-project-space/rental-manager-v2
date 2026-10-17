/** Exact source index prefixes; source creation time retains original ordering. */
export const reservationReadIndexes = {
  "by_account": [
    "account_id"
  ],
  "by_status": [
    "status"
  ],
  "by_account_slug": [
    "account_slug"
  ],
  "by_start_date": [
    "start_date"
  ],
  "by_pickup_date": [
    "pickup_date"
  ],
  "by_hygglo_order_id": [
    "hygglo_order_id"
  ],
  "by_order_step": [
    "order_step"
  ],
  "by_awaiting_owner_action": [
    "awaiting_owner_action"
  ],
  "by_order_step_created_at": [
    "order_step",
    "created_at"
  ],
  "by_awaiting_owner_action_created_at": [
    "awaiting_owner_action",
    "created_at"
  ],
  "by_is_obsolete": [
    "is_obsolete"
  ],
  "by_is_obsolete_start_date": [
    "is_obsolete",
    "start_date"
  ],
  "by_account_status": [
    "account_slug",
    "status"
  ],
  "by_status_start_date": [
    "status",
    "start_date"
  ],
  "by_account_status_start_date": [
    "account_slug",
    "status",
    "start_date"
  ],
  "by_account_status_end_date": [
    "account_slug",
    "status",
    "end_date"
  ],
  "by_account_status_return_date": [
    "account_slug",
    "status",
    "return_date"
  ],
  "by_account_pickup_date": [
    "account_slug",
    "pickup_date"
  ],
  "by_account_status_pickup_date": [
    "account_slug",
    "status",
    "pickup_date",
    "start_date"
  ],
  "by_status_pickup_date": [
    "status",
    "pickup_date",
    "start_date"
  ],
  "by_status_return_date": [
    "status",
    "return_date"
  ],
  "by_status_return_end_date": [
    "status",
    "return_date",
    "end_date"
  ],
  "by_status_end_date": [
    "status",
    "end_date"
  ],
  "by_status_order_step_end_date": [
    "status",
    "order_step",
    "end_date"
  ],
  "by_account_start": [
    "account_slug",
    "start_date"
  ],
  "by_account_end": [
    "account_slug",
    "end_date"
  ],
  "by_account_order_step": [
    "account_slug",
    "order_step"
  ],
  "by_account_obsolete_start": [
    "account_slug",
    "is_obsolete",
    "start_date"
  ]
} as const;
export const reservationReadFields = ["account_id","status","account_slug","start_date","pickup_date","hygglo_order_id","order_step","awaiting_owner_action","created_at","is_obsolete","end_date","return_date"] as const;
