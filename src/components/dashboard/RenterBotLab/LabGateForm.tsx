"use client";

import { useState } from "react";

export function LabGateForm() {
  const [secret, setSecret] = useState("");
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);

  async function submit() {
    setLoading(true);
    setError(false);
    try {
      const res = await fetch("/api/renter-bot-lab-auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret }),
      });
      if (res.ok) {
        window.location.reload();
        return;
      }
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#0b0c10] text-[#e4e6eb]">
      <div className="w-full max-w-sm space-y-4 rounded-lg border border-white/10 bg-white/[0.03] p-6">
        <h1 className="text-lg font-semibold">Renter Bot Lab</h1>
        <p className="text-sm text-[#8b8fa3]">
          Internal test-only tool — never contacts a real renter. Enter the
          lab passphrase to continue.
        </p>
        <input
          type="password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          className="w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 text-sm text-[#e4e6eb] outline-none focus:border-white/30"
          placeholder="Passphrase"
          autoFocus
        />
        {error && (
          <p className="text-sm text-red-400">Incorrect passphrase.</p>
        )}
        <button
          onClick={submit}
          disabled={loading || !secret}
          className="w-full rounded-md bg-white/10 px-3 py-2 text-sm font-medium text-[#e4e6eb] transition-colors hover:bg-white/20 disabled:opacity-50"
        >
          {loading ? "Checking…" : "Enter"}
        </button>
      </div>
    </div>
  );
}
