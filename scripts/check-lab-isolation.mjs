/** Real backend qualification. Creates one test session and always cleans up that session. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

function run(name, args) {
  return JSON.parse(execFileSync("node_modules/.bin/convex", ["run", name, JSON.stringify(args)], {
    encoding: "utf8", timeout: 180_000, maxBuffer: 2_000_000,
  }));
}
function inspect() {
  const source = 'const real = await ctx.db.query("reservations").withIndex("by_hygglo_order_id",q=>q.gte("hygglo_order_id","__probe__").lt("hygglo_order_id","__probe__\\uffff")).collect(); const lab = await ctx.db.query("renter_bot_lab_bookings").collect(); return {real:real.map(r=>r.hygglo_order_id), lab:lab.map(r=>r.hygglo_order_id)};';
  return JSON.parse(execFileSync("node_modules/.bin/convex", ["run", "--inline-query", source], { encoding: "utf8" }));
}
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());
const day = (n) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const thread = `__probe__isolation-qualification-${Date.now()}`;
const stockRequest = { item_name: "Sony FX3", account_slug: "leo", start_date: day(7), end_date: day(9), quantity: 1 };
const stockBefore = run("renter_bot_tools:check_availability", stockRequest);
const before = inspect();
assert.deepEqual(before.real, [], "Migrate old simulated bookings before qualifying isolation");
let proof;
try {
  run("renter_bot_probe:seed", {
    thread_id: thread, account_slug: "leo", items: [{ name: "Sony FX3" }],
    booking: { status: "confirmed", order_step: "BOOKED_AFTER_VERIFIED", start_date: day(7), end_date: day(9) },
    messages: [{ role: "renter", text: "Where do I collect my confirmed camera booking?" }],
  });
  run("renter_bot_lab_order:seed", { thread_id: thread, account_slug: "leo", item_names: ["Sony FX3"], start_date: day(7), end_date: day(9) });
  const added = inspect();
  assert.deepEqual(added.real, [], "Test seeding entered production reservations");
  assert(added.lab.includes(thread));
  const stockAfter = run("renter_bot_tools:check_availability", stockRequest);
  for (const key of ["available", "free_units", "total_units", "reason"])
    assert.deepEqual(stockAfter[key], stockBefore[key], `Simulation changed actual stock: ${key}`);
  const change = run("renter_bot_lab_order:applyChange", { thread_id: thread, action: "set_dates", start_date: day(10), end_date: day(12) });
  assert.equal(change.ok, true);
  const listing = run("renter_bot_tools:get_listing_context", { thread_id: thread });
  const context = run("replyInbox:getThreadContext", { thread_id: thread });
  for (const data of [listing, context]) {
    assert.equal(data.start_date, day(10)); assert.equal(data.end_date, day(12));
  }
  const renter = run("renter_bot_tools:get_renter_context", { thread_id: thread });
  assert.equal(renter.rental_stage.stage, "CONFIRMED_UPCOMING");
  const draft = run("replyInbox_actions:generateDraft", { thread_id: thread });
  assert.equal(draft.status, "ok", `Confirmed collection reply withheld: ${draft.reason}`);
  assert(draft.draft?.trim(), "No actual reply was produced");
  assert.equal(draft.evidence?.stage, "CONFIRMED_UPCOMING");
  proof = { thread, real_simulated_rows: added.real.length, stock_unchanged: true, edited_dates: [listing.start_date, listing.end_date], stage: renter.rental_stage.stage, model: draft.model_id, draft: draft.draft };
} finally {
  run("renter_bot_probe:cleanup", { thread_id: thread });
  const after = inspect();
  assert(!after.lab.includes(thread), "Cleanup left its booking snapshot behind");
  for (const prior of before.lab) assert(after.lab.includes(prior), "Cleanup deleted another Lab's snapshot");
  assert.deepEqual(after.real, []);
}
console.log(JSON.stringify({ ...proof, cleanup_preserved_other_sessions: true }, null, 2));
