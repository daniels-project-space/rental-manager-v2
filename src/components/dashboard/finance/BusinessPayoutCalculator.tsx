"use client";
import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { FinanceAccessGate } from "./FinanceAccessGate";
import { Modal } from "@/components/ui/Modal";
import type { Doc } from "../../../../convex/_generated/dataModel";
export const money = (p: number) =>
  new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(
    p / 100,
  );
const input =
  "rounded-lg border border-white/20 bg-white/5 px-3 py-2 w-full text-sm";
const button =
  "rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm hover:bg-white/10 disabled:opacity-40";
function PayoutContent() {
  const [month, setMonth] = useState(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/London",
      year: "numeric",
      month: "2-digit",
    }).format(new Date()),
  );
  const data = useQuery(api.finance.overview, { month });
  const freeze = useMutation(api.finance.freeze);
  const save = useMutation(api.finance.saveEntry);
  const [ratio, setRatio] = useState("50");
  const [override, setOverride] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Doc<"finance_entries"> | null>(null);
  const [kind, setKind] = useState<"expense" | "withdrawal" | "settlement">(
    "expense",
  );
  const [person, setPerson] = useState<"Daniel" | "Leo">("Daniel");
  const [amount, setAmount] = useState("");
  const [label, setLabel] = useState("");
  const [entryMonth, setEntryMonth] = useState(month);
  const [recurring, setRecurring] = useState(false);
  const [endMonth, setEndMonth] = useState("");
  const [reason, setReason] = useState("");
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  };
  const reset = () => {
    setEditing(null);
    setAmount("");
    setLabel("");
    setReason("");
    setRecurring(false);
    setEndMonth("");
  };
  const edit = (row: Doc<"finance_entries">) => {
    setEditing(row);
    setKind(row.kind);
    setPerson(row.person ?? "Daniel");
    setAmount(String(row.amount / 100));
    setLabel(row.label);
    setEntryMonth(row.month);
    setRecurring(row.recurring);
    setEndMonth(row.end_month ?? "");
    setReason("");
  };
  const submit = async (voided = false) => {
    await save({
      id: editing?._id,
      expectedUpdatedAt: editing?.updated_at,
      kind,
      person: kind === "expense" ? undefined : person,
      month: entryMonth,
      amountGbp: Number(amount),
      label,
      recurring: kind === "expense" && recurring,
      endMonth:
        kind === "expense" && recurring && endMonth ? endMonth : undefined,
      voided,
      reason,
    });
    reset();
  };
  if (!data) return <p className="p-6">Loading business accounts…</p>;
  const revenue =
    override === "" ? data.source : Math.round(Number(override) * 100);
  const profit = revenue - data.expenses;
  const daniel = Math.round((profit * Number(ratio)) / 100);
  return (
    <div className="space-y-6">
      <p className="text-sm text-white/60">
        Freeze saves a monthly accounting snapshot. Billing, payments and
        invoice imports continue. Balances use the latest frozen revision of
        each month and all logged withdrawals.
      </p>
      {error && (
        <p role="alert" className="rounded-lg bg-red-500/15 p-3 text-red-200">
          {error}
        </p>
      )}
      <div className="grid gap-4 md:grid-cols-3">
        <label className="text-sm">
          Accounting month
          <input
            type="month"
            className={input}
            value={month}
            onChange={(e) => {
              if (e.target.value) {
                setMonth(e.target.value);
                setEntryMonth(e.target.value);
              }
            }}
          />
        </label>
        <div>
          <p className="text-white/60 text-sm">
            Month Confirmed · all accounts
          </p>
          <p className="text-2xl font-semibold">{money(data.source)}</p>
          <p className="text-xs text-white/50">
            Confirmed rentals plus credited claims
          </p>
        </div>
        <div>
          <p className="text-white/60 text-sm">Expenses for this month</p>
          <p className="text-2xl font-semibold">{money(data.expenses)}</p>
          <p className="text-xs text-white/50">Deducted before splitting</p>
        </div>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(() =>
            freeze({
              month,
              danielBps: Math.round(Number(ratio) * 100),
              overrideGbp: override === "" ? undefined : Number(override),
              note,
              expectedRevision: data.current?.revision ?? 0,
            }),
          );
        }}
        className="rounded-xl border border-white/15 p-4 space-y-3"
      >
        <h3 className="font-semibold">Freeze or recalculate {month}</h3>
        <div className="grid gap-3 md:grid-cols-3">
          <label className="text-sm">
            Daniel share (%)
            <input
              required
              type="number"
              min="0"
              max="100"
              step="0.01"
              value={ratio}
              onChange={(e) => setRatio(e.target.value)}
              className={input}
            />
          </label>
          <label className="text-sm">
            Revenue correction (£, optional)
            <input
              type="number"
              step="0.01"
              value={override}
              onChange={(e) => setOverride(e.target.value)}
              className={input}
              placeholder="Use Month Confirmed"
            />
          </label>
          <label className="text-sm">
            Snapshot note
            <input
              required
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className={input}
              placeholder="Reason for freeze or correction"
            />
          </label>
        </div>
        <p className="text-sm">
          Revenue {money(revenue)} − expenses {money(data.expenses)} =
          distributable {money(profit)}
        </p>
        <div className="flex rounded-lg overflow-hidden text-sm">
          <div
            className="bg-teal-700 p-3"
            style={{ width: `${Math.max(5, Math.min(95, Number(ratio)))}%` }}
          >
            Daniel {money(daniel)}
          </div>
          <div className="bg-indigo-700 p-3 flex-1">
            Leo {money(profit - daniel)}
          </div>
        </div>
        <button disabled={busy} className={button} type="submit">
          {data.current
            ? `Freeze revision ${data.current.revision + 1}`
            : "Freeze month"}
        </button>
        {data.current && (
          <p className="text-xs text-white/60">
            Current freeze: revenue {money(data.current.revenue)}, expenses{" "}
            {money(data.current.expenses)}, Daniel{" "}
            {data.current.daniel_bps / 100}% ·{" "}
            {new Date(data.current.created_at).toLocaleString()} ·{" "}
            {data.current.note}. Changes to revenue or expenses take effect when
            you freeze again.
          </p>
        )}
      </form>
      <div className="grid gap-4 md:grid-cols-2">
        {(["Daniel", "Leo"] as const).map((name) => (
          <div
            key={name}
            className="rounded-xl border border-white/15 p-5 space-y-2"
          >
            <h3 className="font-semibold text-lg">{name}</h3>
            <p className="text-3xl">{money(data.totals[name].business)}</p>
            <p className="text-sm text-white/60">
              Allowance from calculated business balance
            </p>
            <p className="text-sm">
              Owed by {name === "Leo" ? "Daniel" : "Leo"}:{" "}
              <strong>{money(data.totals[name].owed)}</strong>
            </p>
            <p className="text-sm">
              Over allowance:{" "}
              <strong
                className={data.totals[name].excess ? "text-red-300" : ""}
              >
                {money(data.totals[name].excess)}
              </strong>
            </p>
            <p className="text-xs text-white/50">
              Carried balance: {money(data.totals.balance[name])}
            </p>
          </div>
        ))}
      </div>
      <p className="text-sm">
        Calculated business balance: <strong>{money(data.totals.cash)}</strong>.
        This is an accounting calculation; check the bank before withdrawing. A
        partner owes money only after exceeding their allowance.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => submit(false));
        }}
        className="rounded-xl border border-white/15 p-4 space-y-3"
      >
        <h3 className="font-semibold">
          {editing
            ? "Correct ledger entry"
            : "Add expense, withdrawal or repayment"}
        </h3>
        <div className="grid gap-3 md:grid-cols-3">
          <label className="text-sm">
            Entry type
            <select
              className={input}
              value={kind}
              onChange={(e) => setKind(e.target.value as typeof kind)}
            >
              <option value="expense">Business expense</option>
              <option value="withdrawal">Business withdrawal / return</option>
              <option value="settlement">Direct repayment to partner</option>
            </select>
          </label>
          <label className="text-sm">
            Month
            <input
              required
              type="month"
              className={input}
              value={entryMonth}
              onChange={(e) => setEntryMonth(e.target.value)}
            />
          </label>
          {kind !== "expense" && (
            <label className="text-sm">
              {kind === "settlement"
                ? "Person paying partner"
                : "Person withdrawing / returning"}
              <select
                className={input}
                value={person}
                onChange={(e) => setPerson(e.target.value as typeof person)}
              >
                <option>Daniel</option>
                <option>Leo</option>
              </select>
            </label>
          )}
          <label className="text-sm">
            Amount (£)
            <input
              required
              type="number"
              step="0.01"
              className={input}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </label>
          <label className="text-sm">
            Description
            <input
              required
              className={input}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Insurance / withdrawal / repayment"
            />
          </label>
          <label className="text-sm">
            Reason for this record
            <input
              required
              className={input}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
        </div>
        {kind === "expense" && (
          <div className="flex gap-3 items-center text-sm">
            <label>
              <input
                type="checkbox"
                checked={recurring}
                onChange={(e) => setRecurring(e.target.checked)}
              />{" "}
              Repeat every month
            </label>
            {recurring && (
              <label>
                Until (optional)
                <input
                  type="month"
                  className={input}
                  value={endMonth}
                  onChange={(e) => setEndMonth(e.target.value)}
                />
              </label>
            )}
          </div>
        )}
        <p className="text-xs text-white/50">
          {kind === "settlement"
            ? "Records money paid directly to the other partner. It clears their debt without reducing business cash again."
            : kind === "withdrawal"
              ? "Positive amount = taken from business; negative amount = returned to business."
              : "Recurring expenses apply from the start month through the end month. Refreeze affected months after corrections."}
        </p>
        <div className="flex gap-2">
          <button className={button} disabled={busy}>
            Save entry
          </button>
          {editing && (
            <>
              <button
                type="button"
                className={button}
                disabled={busy}
                onClick={() => void run(() => submit(true))}
              >
                Void entry (retain audit)
              </button>
              <button type="button" className={button} onClick={reset}>
                Cancel edit
              </button>
            </>
          )}
        </div>
      </form>
      <div className="overflow-x-auto">
        <h3 className="font-semibold mb-2">Monthly freezes</h3>
        <table className="w-full text-sm text-left">
          <thead>
            <tr>
              {[
                "Month",
                "Revision",
                "Revenue",
                "Expenses",
                "Daniel share",
                "Leo share",
                "Daniel carried",
                "Leo carried",
              ].map((x) => (
                <th className="p-2" key={x}>
                  {x}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.months.map((s) => (
              <tr className="border-t border-white/10" key={s._id}>
                <td className="p-2">
                  <button
                    onClick={() => {
                      setMonth(s.month);
                      setRatio(String(s.daniel_bps / 100));
                      setOverride("");
                    }}
                  >
                    {s.month}
                  </button>
                </td>
                <td>{s.revision}</td>
                <td>{money(s.revenue)}</td>
                <td>{money(s.expenses)}</td>
                <td>{money(s.daniel)}</td>
                <td>{money(s.leo)}</td>
                <td>{money(s.carried.balance.Daniel)}</td>
                <td>{money(s.carried.balance.Leo)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!data.months.length && (
          <p className="text-sm text-white/50 p-3">No months frozen yet.</p>
        )}
      </div>
      <div>
        <h3 className="font-semibold mb-2">
          Ledger · corrections remain logged
        </h3>
        <div className="space-y-2">
          {data.entries.map((e) => (
            <div
              className={`flex flex-wrap gap-3 justify-between rounded-lg bg-white/5 p-3 text-sm ${e.voided ? "opacity-50" : ""}`}
              key={e._id}
            >
              <span>
                {e.month} · {e.kind} · {e.person ?? "business"} · {e.label}{" "}
                {e.recurring
                  ? `(monthly${e.end_month ? ` until ${e.end_month}` : ""})`
                  : ""}{" "}
                {e.voided ? "· VOID" : ""}
              </span>
              <span>
                {money(e.amount)}{" "}
                <button className="underline ml-3" onClick={() => edit(e)}>
                  Edit / {e.voided ? "restore" : "void"}
                </button>
              </span>
            </div>
          ))}
        </div>
      </div>
      <details>
        <summary className="cursor-pointer">
          Snapshot revisions and audit history
        </summary>
        <div className="text-xs space-y-2 mt-3">
          {data.revisions.map((s) => (
            <p key={s._id}>
              {s.month} revision {s.revision}: {money(s.revenue)} −{" "}
              {money(s.expenses)} = {money(s.profit)} · {s.note} ·{" "}
              {new Date(s.created_at).toLocaleString()}
            </p>
          ))}
          {data.audit.map((a) => (
            <div key={a._id}>
              {new Date(a.created_at).toLocaleString()} · {a.operation} ·{" "}
              {a.reason}
              <details>
                <summary>Before / after</summary>
                <pre className="overflow-auto">
                  {JSON.stringify(
                    { before: a.before, after: a.after },
                    null,
                    2,
                  )}
                </pre>
              </details>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}
export function BusinessPayoutCalculator() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="w-full rounded-xl border border-white/10 bg-white/5 p-5 text-left hover:bg-white/10"
      >
        <span className="font-semibold">Business Payout Calculator ↗</span>
        <p className="text-sm text-white/50 mt-1">
          Freeze monthly profit, split Daniel / Leo, track expenses and
          withdrawals.
        </p>
      </button>
      {open && (
        <Modal width="max-w-6xl" onClose={() => setOpen(false)}>
          <div
            className="max-h-[85dvh] overflow-y-auto pr-2"
            role="dialog"
            aria-modal="true"
            aria-label="Business payout calculator"
          >
            <div className="flex justify-between gap-3 mb-5">
              <h2 className="text-xl font-semibold">
                Business Payout Calculator
              </h2>
              <button
                aria-label="Close calculator"
                onClick={() => setOpen(false)}
              >
                ✕
              </button>
            </div>
            <FinanceAccessGate>
              <PayoutContent />
            </FinanceAccessGate>
          </div>
        </Modal>
      )}
    </>
  );
}
