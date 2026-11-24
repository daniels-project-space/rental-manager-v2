"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";

type Rule = {
  original_item_id?: Id<"items">;
  missing_original?: { descriptor_id: string; label: string; quantity: number; source_url: string; source_excerpt: string };
  replacement_item_id: Id<"items">;
  qty: number;
  price_adjustment_pence: number;
  extension_adjustment_pence?: number[];
  replacement_size_score: number;
  weights: { item_id: Id<"items">; weight_grams: number }[];
  review_note: string;
};

function RateEditor({ account, productId, revision, rules, index, names }: { account: string; productId: number; revision: string; rules: Rule[]; index: number; names: Record<string, string> }) {
  const rule = rules[index];
  const [values, setValues] = useState(() => Array.from({ length: 30 }, (_, day) => rule.extension_adjustment_pence?.[day] === undefined ? "" : (rule.extension_adjustment_pence[day] / 100).toFixed(2)));
  const [note, setNote] = useState(rule.review_note);
  const [dailyAdjustment, setDailyAdjustment] = useState("");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const save = useMutation(api.listing_overrides.setComponentReplacements);

  function fillFromDaily() {
    if (!/^-?\d+(?:\.\d{1,2})?$/.test(dailyAdjustment.trim())) {
      setMessage("Enter an exact daily adjustment first.");
      return;
    }
    const dailyPence = Math.round(Number(dailyAdjustment) * 100);
    if (!Number.isSafeInteger(dailyPence) || Math.abs(dailyPence * 30) > 100000000) {
      setMessage("The daily adjustment is too large.");
      return;
    }
    setValues(Array.from({ length: 30 }, (_, day) => (dailyPence * (day + 1) / 100).toFixed(2)));
    setMessage("Preview generated. Review and edit every amount before saving.");
  }

  async function saveRates() {
    if (values.some(value => !/^-?\d+(?:\.\d{1,2})?$/.test(value.trim()))) {
      setMessage("Enter an exact adjustment for every duration.");
      return;
    }
    const rates = values.map(value => Math.round(Number(value) * 100));
    if (rates.some(value => !Number.isSafeInteger(value) || Math.abs(value) > 100000000) || note.trim().length < 10 || note.length > 500) {
      setMessage("Check the amounts and review note.");
      return;
    }
    setSaving(true);
    setMessage("");
    try {
      await save({ account_slug: account, product_id: productId, expected_revision: revision, replacements: rules.map((current, ruleIndex) => ({
        ...(current.original_item_id ? { original_item_id: current.original_item_id } : {}), ...(current.missing_original ? { missing_original: current.missing_original } : {}),
        replacement_item_id: current.replacement_item_id, qty: current.qty, price_adjustment_pence: current.price_adjustment_pence,
        replacement_size_score: current.replacement_size_score, weights: current.weights,
        ...(ruleIndex === index ? { extension_adjustment_pence: rates, review_note: note.trim() } : { ...(current.extension_adjustment_pence ? { extension_adjustment_pence: current.extension_adjustment_pence } : {}), review_note: current.review_note }),
      })) });
      setMessage("Reviewed rates saved.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save rates.");
    } finally { setSaving(false); }
  }

  return <details className="rounded-lg border border-amber-400/20 bg-black/20 p-3">
    <summary className="cursor-pointer text-xs text-amber-100">{rule.missing_original?.label ?? names[String(rule.original_item_id)] ?? "Original component"} → {names[String(rule.replacement_item_id)] ?? "Replacement component"}</summary>
    <p className="mt-2 text-xs text-slate-300">Enter the total price difference for each extension duration. Use a minus sign for a reduction; £0 means no adjustment.</p>
    <div className="mt-3 flex flex-wrap items-end gap-2">
      <label className="text-[10px] text-slate-400">Optional daily difference · £
        <input aria-label="Daily extension adjustment in pounds" inputMode="decimal" value={dailyAdjustment} onChange={event => setDailyAdjustment(event.target.value)} className="mt-1 block w-32 rounded border border-white/10 bg-black/30 px-2 py-1 text-xs text-white" />
      </label>
      <button type="button" onClick={fillFromDaily} className="rounded border border-amber-300/30 px-3 py-1 text-xs text-amber-100">Preview 1–30 days</button>
    </div>
    {values.every(Boolean) && <p className="mt-2 text-xs text-emerald-200">Preview: 1 day £{values[0]} · 30 days £{values[29]}</p>}
    <details className="mt-3 rounded-lg border border-white/10 bg-white/[0.02] p-3">
      <summary className="cursor-pointer text-xs font-medium text-amber-100">Review and edit individual durations</summary>
      <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-5">
      {values.map((value, index) => <label key={index} className="text-[10px] text-slate-400">{index + 1} {index ? "days" : "day"} · £
        <input aria-label={`${index + 1} day extension adjustment in pounds`} inputMode="decimal" value={value} onChange={event => setValues(current => current.map((entry, day) => day === index ? event.target.value : entry))} className="mt-1 w-full rounded border border-white/10 bg-black/30 px-2 py-1 text-xs text-white" />
      </label>)}
      </div>
    </details>
    <label className="mt-3 block text-xs text-slate-300">Review note
      <textarea value={note} onChange={event => setNote(event.target.value)} maxLength={500} className="mt-1 w-full rounded border border-white/10 bg-black/30 p-2 text-xs text-white" />
    </label>
    <div className="mt-2 flex items-center gap-3"><button type="button" disabled={saving} onClick={saveRates} className="rounded-lg bg-amber-300 px-3 py-2 text-xs font-semibold text-black disabled:opacity-50">{saving ? "Saving…" : "Save reviewed rates"}</button><span role="status" className="text-xs text-slate-300">{message}</span></div>
  </details>;
}

export function ReviewedReplacementRates({ account, productId }: { account: string; productId: number }) {
  const data = useQuery(api.listing_overrides.getComponentReplacements, { account_slug: account, product_id: productId });
  if (!data) return <p className="text-xs text-slate-400">Loading reviewed component rates…</p>;
  const rules = data.replacements as Rule[];
  return <section className="space-y-2 border-t border-white/10 pt-3">
    <h4 className="text-xs font-semibold text-amber-100">DB Cinema website · component extension rates</h4>
    <p className="text-[11px] text-slate-400">These adjustments do not change Hygglo prices. Component substitutions are not yet available at checkout.</p>
    {rules.length ? rules.map((rule, index) => <RateEditor key={`${data.revision}:${index}`} account={account} productId={productId} revision={data.revision} rules={rules} index={index} names={data.componentNames} />) : <p className="text-xs text-slate-400">No reviewed component replacements for this listing.</p>}
  </section>;
}
