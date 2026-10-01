export const LAB_LIFECYCLES = ["inquiry", "awaiting_owner_approval", "awaiting_payment", "awaiting_verification", "confirmed", "in_use", "completed", "cancelled"] as const;
export type LabLifecycle = typeof LAB_LIFECYCLES[number];
export function labBooking(lifecycle: string, start?: string, end?: string) {
  if (!(LAB_LIFECYCLES as readonly string[]).includes(lifecycle)) throw new Error("Unknown simulation lifecycle");
  if (lifecycle === "inquiry") return undefined;
  if (!start || !end) throw new Error("A booked simulation stage requires pickup and return dates");
  const facts = {
    awaiting_owner_approval: { status: "pending_review", order_step: "REQUEST" },
    awaiting_payment: { status: "pending_review", order_step: "APPROVED" },
    awaiting_verification: { status: "pending_review", order_step: "VERIFIED" },
    confirmed: { status: "confirmed", order_step: "BOOKED_AFTER_VERIFIED" },
    in_use: { status: "ongoing", order_step: "RETURNED" },
    completed: { status: "completed", order_step: "REVIEWED" },
    cancelled: { status: "cancelled", order_step: "CANCELED" },
  } as const;
  return { ...facts[lifecycle as Exclude<LabLifecycle, "inquiry">], start_date: start, end_date: end };
}
