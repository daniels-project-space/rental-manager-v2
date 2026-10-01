/** Live regression for the actual Leo two-FX3/two-lens listing. Always removes its own probe. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
const run = (fn, args) => JSON.parse(execFileSync("node_modules/.bin/convex", ["run", fn, JSON.stringify(args)], { encoding: "utf8", timeout: 180_000, maxBuffer: 2_000_000 }));
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());
const day = (n) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const start = day(1), end = day(3);
const session = run("renter_bot_lab_actions:startLiveSession", { accountSlug: "leo", productId: 1172559, startDate: start, endDate: end });
const thread = session.threadId;
const request = { account_slug: "leo", start_date: start, end_date: end, quantity: 1, thread_id: thread };
let proof;
try {
  const context = run("renter_bot_tools:get_listing_context", { thread_id: thread });
  const item = context.items[0];
  assert.equal(context.start_date, start); assert.equal(context.end_date, end);
  assert.equal(context.rental_stage.stage, "INQUIRY");
  assert.equal(item.kind, "camera"); assert.equal(item.inventory_name, "Sony FX3");
  assert.equal(item.mapping_complete, true);
  assert.deepEqual(item.inventory_components.map((c) => [c.name, c.requested_units]), [["Sony FX3", 2], ["Sony GM 24-70mm f2.8", 2]]);
  const independent = item.inventory_components.map((c) => run("renter_bot_tools:check_availability", { ...request, item_name: c.name, quantity: c.requested_units }));
  const kit = run("renter_bot_tools:check_availability", { ...request, item_name: item.name, product_id: 1172559 });
  const expected = independent.some((r) => r.available === false) ? false : independent.every((r) => r.available === true) ? true : null;
  assert.equal(kit.available, expected, "Kit verdict disagrees with independently checked components");
  const draft = run("renter_bot_lab_actions:sendTestMessage", { threadId: thread, accountSlug: "leo", text: `Are both FX3 cameras and both 24-70mm lenses in this kit available from ${start} to ${end}?` });
  if (draft.status !== "ok") console.error(JSON.stringify(draft, null, 2));
  assert.equal(draft.status, "ok", `Real kit reply withheld: ${draft.reason}`);
  assert(draft.draft?.trim());
  for (const component of independent) assert(draft.evidence?.stock.some((r) => r.item === component.item_name && r.quantity === 2 && r.start_date === start && r.end_date === end && r.available === component.available), `Draft did not check two ${component.item_name}`);
  if (expected === false) console.error(JSON.stringify({ candidate: draft.draft, flags: draft.flags }, null, 2));
  if (expected === false) assert(/not available|unavailable|can(?:not|'t).*two|only.*one|only.*1|can(?:not|'t).*both|not.*both|not.*two/i.test(draft.draft), "No clear answer that the requested two-camera kit cannot be fulfilled");
  proof = { dates: [start,end], expected, whole_kit: kit.available, independent: independent.map((r) => ({ item: r.item_name, units: r.requested_units, free: r.free_units, available: r.available })), model: draft.model_id, draft: draft.draft, receipt_count: draft.evidence.stock.length };
} finally { run("renter_bot_probe:cleanup", { thread_id: thread }); }
console.log(JSON.stringify(proof, null, 2));
