import { amendedDraftContext, type DraftContextTransition } from "./draft_review";

type Line = { product_id: number; name: string; qty: number; line_total_gbp: number };
type Snapshot = { account_slug: string; stage: string; start_date: string; end_date: string;
  total_gbp: number; lines: Line[]; changes: Array<{ request_key?: string }> };

function snapshot(value: unknown): Snapshot | null {
  if (!value || typeof value !== "object") return null;
  const s = value as Snapshot;
  if (typeof s.account_slug !== "string" || !["CONFIRMED_UPCOMING", "ACTIVE"].includes(s.stage)
    || typeof s.start_date !== "string" || typeof s.end_date !== "string"
    || !Number.isFinite(s.total_gbp) || s.total_gbp <= 0 || !Array.isArray(s.lines)
    || !s.lines.length || !Array.isArray(s.changes)
    || s.lines.some(l => !l || !Number.isInteger(l.product_id) || l.product_id <= 0
      || typeof l.name !== "string" || !l.name.trim() || /[\r\n]/.test(l.name)
      || !Number.isInteger(l.qty) || l.qty <= 0 || !Number.isFinite(l.line_total_gbp) || l.line_total_gbp <= 0)
    || new Set(s.lines.map(l => l.product_id)).size !== s.lines.length
    || Math.round(s.lines.reduce((n,l) => n+l.line_total_gbp,0)*100) !== Math.round(s.total_gbp*100)) return null;
  return s;
}

/** Stored Native orders and request keys prove the edit, never a model action flag.
 * Initially supports one atomic addition; other changes retain human review. */
export function committedAdditionConfirmation(input: {
  threadId: string; account: string; messageId: string; beforeKey: string; afterKey: string;
  transitions: DraftContextTransition[]; before: unknown; after: unknown;
}): string | null {
  const { threadId, account, messageId, beforeKey, afterKey, transitions } = input;
  if (!messageId || !threadId.startsWith("__probe__") || transitions.length !== 1
    || amendedDraftContext(beforeKey,threadId,transitions) !== afterKey) return null;
  const before = snapshot(input.before), after = snapshot(input.after);
  if (!before || !after || before.account_slug !== account || after.account_slug !== account
    || before.start_date !== after.start_date || before.end_date !== after.end_date
    || after.changes.length !== before.changes.length+1
    || transitions[0].before_revision !== before.changes.length
    || transitions[0].after_revision !== after.changes.length
    || JSON.stringify(after.changes.slice(0,-1)) !== JSON.stringify(before.changes)) return null;
  let request: unknown;
  try { request = JSON.parse(after.changes.at(-1)?.request_key ?? ""); } catch { return null; }
  if (!Array.isArray(request) || request.length !== 3 || request[0] !== messageId
    || request[1] !== "add_items" || !Array.isArray(request[2]) || !request[2].length) return null;
  const added: Array<{product_id:number;qty:number;name:string}> = [];
  for (const old of before.lines) {
    const current = after.lines.find(l => l.product_id === old.product_id);
    if (!current || current.name !== old.name || current.qty < old.qty
      || Math.round(current.line_total_gbp/current.qty*100) !== Math.round(old.line_total_gbp/old.qty*100)) return null;
  }
  for (const line of after.lines) {
    const qty = line.qty-(before.lines.find(l => l.product_id === line.product_id)?.qty ?? 0);
    if (qty > 0) added.push({product_id:line.product_id,qty,name:line.name});
  }
  added.sort((a,b) => a.product_id-b.product_id);
  if (!added.length || JSON.stringify(added.map(({product_id,qty}) => ({product_id,qty}))) !== JSON.stringify(request[2])) return null;
  const dates = [after.start_date,after.end_date].map(value => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const date = new Date(value+"T00:00:00Z");
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0,10) === value ? date : null;
  });
  if (!dates[0] || !dates[1] || dates[1] < dates[0]) return null;
  const format = (date: Date) => date.toLocaleDateString("en-GB",{day:"numeric",month:"long",year:"numeric",timeZone:"UTC"});
  const period = after.start_date === after.end_date ? format(dates[0]) : `${format(dates[0])} to ${format(dates[1])}`;
  const names = added.map(l => `${l.qty}x ${l.name}`).join(" and ");
  const total = Number(after.total_gbp.toFixed(2)).toString();
  return `I've added ${names} to your booking for ${period}. The updated booking total is £${total}.`;
}
