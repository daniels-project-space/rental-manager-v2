"use client";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { useAccount } from "@/lib/account-context";
import { useState } from "react";
import { Modal } from "@/components/ui/Modal";

const CLAIM_STATUSES = [
  { value: "open", label: "Open" },
  { value: "settled", label: "Settled" },
  { value: "denied", label: "Denied" },
] as const;

type ClaimStatus = (typeof CLAIM_STATUSES)[number]["value"];

const INPUT_STYLE = {
  background: "rgba(255,255,255,0.05)",
  border: "1px solid rgba(255,255,255,0.1)",
  color: "#e4e6eb",
} as const;

export function ClaimsRecordingModal({ onClose }: { onClose: () => void }) {
  const { activeAccountSlug } = useAccount();
  const createClaim = useMutation(api.insurance_claims.create);
  const items = useQuery(api.items.listActive, {});

  const [itemName, setItemName] = useState("");
  const [amountGbp, setAmountGbp] = useState("");
  const [claimDate, setClaimDate] = useState(
    () => new Date().toISOString().slice(0, 10)
  );
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<ClaimStatus>("open");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit() {
    const amount = parseFloat(amountGbp);
    if (!amountGbp || isNaN(amount) || amount <= 0) {
      setError("Enter a valid amount");
      return;
    }
    if (!claimDate) {
      setError("Enter a claim date");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await createClaim({
        account_slug: activeAccountSlug ?? undefined,
        item_name_canonical: itemName || undefined,
        amount_gbp: amount,
        claim_date: claimDate,
        description: description || undefined,
        status,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  return (
    <Modal onClose={onClose}>
      <h3 className="text-base font-semibold text-[#e4e6eb] mb-4">
        Record Insurance Claim
      </h3>

      <div className="space-y-3">
        <div>
          <label className="text-xs text-[#8b8fa3] mb-1 block">Item (optional)</label>
          <select
            value={itemName}
            onChange={(e) => setItemName(e.target.value)}
            className="w-full text-sm rounded-lg px-3 py-2"
            style={INPUT_STYLE}
          >
            <option value="">No specific item</option>
            {(items ?? []).map((i) => (
              <option key={i.id} value={i.name}>{i.name}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="text-xs text-[#8b8fa3] mb-1 block">Amount (£)</label>
          <input
            type="number"
            min="0"
            step="0.01"
            placeholder="e.g. 150.00"
            value={amountGbp}
            onChange={(e) => setAmountGbp(e.target.value)}
            className="w-full text-sm rounded-lg px-3 py-2"
            style={INPUT_STYLE}
          />
        </div>

        <div>
          <label className="text-xs text-[#8b8fa3] mb-1 block">Claim Date</label>
          <input
            type="date"
            value={claimDate}
            onChange={(e) => setClaimDate(e.target.value)}
            className="w-full text-sm rounded-lg px-3 py-2"
            style={INPUT_STYLE}
          />
        </div>

        <div>
          <label className="text-xs text-[#8b8fa3] mb-1 block">Status</label>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as ClaimStatus)}
            className="w-full text-sm rounded-lg px-3 py-2"
            style={INPUT_STYLE}
          >
            {CLAIM_STATUSES.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="text-xs text-[#8b8fa3] mb-1 block">Description (optional)</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className="w-full text-sm rounded-lg px-3 py-2 resize-none"
            style={INPUT_STYLE}
          />
        </div>
      </div>

      {error && (
        <p className="text-xs mt-2" style={{ color: "#ef4444" }}>{error}</p>
      )}

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
            background: "rgba(255,255,255,0.1)",
            color: "#e4e6eb",
            border: "1px solid rgba(255,255,255,0.2)",
            opacity: saving ? 0.6 : 1,
          }}
        >
          {saving ? "Saving…" : "Record Claim"}
        </button>
      </div>
    </Modal>
  );
}
