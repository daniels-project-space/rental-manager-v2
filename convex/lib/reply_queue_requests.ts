import type { QueryCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";

/** Keep late imports while reading only rows that can enter the request pass.
 * Each equality index includes Convex's immutable _creationTime suffix, so its
 * restricted order matches filtering the former by_creation_time result. */
export async function loadReplyQueueRequestRows(ctx: QueryCtx, cutoff: number) {
  const [stepCreated, actionCreated, stepInserted, actionInserted] = await Promise.all([
    ctx.db.query("reservations").withIndex("by_order_step_created_at", q =>
      q.eq("order_step", "REQUEST").gte("created_at", cutoff)).collect(),
    ctx.db.query("reservations").withIndex("by_awaiting_owner_action_created_at", q =>
      q.eq("awaiting_owner_action", true).gte("created_at", cutoff)).collect(),
    ctx.db.query("reservations").withIndex("by_order_step", q =>
      q.eq("order_step", "REQUEST").gte("_creationTime", cutoff)).collect(),
    ctx.db.query("reservations").withIndex("by_awaiting_owner_action", q =>
      q.eq("awaiting_owner_action", true).gte("_creationTime", cutoff)).collect(),
  ]);
  const unique = (rows: Doc<"reservations">[]) =>
    [...new Map(rows.map(row => [String(row._id), row])).values()];
  return { byStep: unique([...stepCreated, ...stepInserted]), byAction: unique([...actionCreated, ...actionInserted]) };
}
