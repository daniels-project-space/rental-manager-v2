"use client";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { useAccount } from "@/lib/account-context";
import { useState } from "react";
import { Modal } from "@/components/ui/Modal";

const DENIAL_REASONS = [
  { value: "price_too_high", label: "Price too high" },
  { value: "not_available", label: "Not available" },
  { value: "no_response", label: "No response from renter" },
  { value: "competitor", label: "Chose competitor" },
  { value: "other", label: "Other" },
] as const;

type DenialReason = (typeof DENIAL_REASONS)[number]["value"];

const INPUT_STYLE = {
  background: "rgba(255,255,255,0.05)",
  border: "1px solid rgba(255,255,255,0.1)",
  color: "#e4e6eb",
} as const;

export function DenialRecordingModal({ onClose }: { onClose: () => void }) {
  const { activeAccountSlug } = useAccount();
  const createDenial = useMutation(api.denial_records.createDenial);
  const items = useQuery(api.items.listActive, {});

  const [itemName, setItemName] = useState("");
  const [reason, setReason] = useState<DenialReason>("price_too_high");
  const [estimatedValue, setEstimatedValue] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit() {
    if (!itemName) { setError("Select an item"); return; }
    setSaving(true);
    setError("");
    try {
      await createDenial({
        itemName,
        reason,
        estimatedValue: estimatedValue ? parseFloat(estimatedValue) : undefined,
        notes: notes || undefined,
        accountSlug: activeAccountSlug ?? undefined,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  return (
    <Modal onClose={onClose}>
      <h3 className="text-base font-semibold text-[#e4e6eb] mb-4">Record Denial</h3>

      <div className="space-y-3">
        <div>
          <label className="text-xs text-[#8b8fa3] mb-1 block">Item</label>
          <select
            value={itemName}
            onChange={(e) => setItemName(e.target.value)}
            className="w-full text-sm rounded-lg px-3 py-2"
            style={INPUT_STYLE}
          >
            <option value="">Select item…</option>
            {(items ?? []).map((i) => (
              <option key={i.id} value={i.name}>{i.name}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="text-xs text-[#8b8fa3] mb-1 block">Reason</label>
          <select
            value={reason}
            onChange={(e) => setReason(e.target.value as DenialReason)}
            className="w-full text-sm rounded-lg px-3 py-2"
            style={INPUT_STYLE}
          >
            {DENIAL_REASONS.map((r) => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="text-xs text-[#8b8fa3] mb-1 block">Estimated Value (£)</label>
          <input
            type="number"
            min="0"
            step="0.01"
            placeholder="e.g. 45.00"
            value={estimatedValue}
            onChange={(e) => setEstimatedValue(e.target.value)}
            className="w-full text-sm rounded-lg px-3 py-2"
            style={INPUT_STYLE}
          />
        </div>

        <div>
          <label className="text-xs text-[#8b8fa3] mb-1 block">Notes (optional)</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            className="w-full text-sm rounded-lg px-3 py-2 resize-none"
            style={INPUT_STYLE}
          />
        </div>
      </div>

      {error && <p className="text-xs mt-2" style={{ color: "#ef4444" }}>{error}</p>}

      <div className="flex gap-2 justify-end mt-4">
        <button
          onClick={onClose}
          className="text-sm px-3 py-1.5 rounded text-[#8b8fa3] hover:text-[#e4e6eb] transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={handleSubmit}
          disabled={saving}
          className="text-sm px-4 py-1.5 rounded transition-colors"
          style={{
            background: "rgba(239,68,68,0.15)",
            color: "#ef4444",
            border: "1px solid rgba(239,68,68,0.3)",
            opacity: saving ? 0.6 : 1,
          }}
        >
          {saving ? "Saving…" : "Record"}
        </button>
      </div>
    </Modal>
  );
}
