"use client";
import { useConvexAuth, useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
export function FinanceAccessGate({ children }: { children: React.ReactNode }) {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const owner = useQuery(api.auth.state, isAuthenticated ? {} : "skip");
  if (isLoading || (isAuthenticated && owner === undefined))
    return <p className="p-5 text-sm text-white/60">Checking owner sign-in…</p>;
  if (!isAuthenticated || !owner?.isOwner)
    return (
      <div className="rounded-xl border border-white/15 bg-white/5 p-6 space-y-3">
        <h3 className="text-lg font-semibold">
          Sign in to open your finance tools
        </h3>
        <p className="text-sm text-white/60">
          Invoice documents and business payout records are private. Use your
          Rental Manager owner account. For first-time setup, open your private
          invitation link.
        </p>
        <a
          href="/login"
          className="inline-block rounded-lg bg-blue-600 px-4 py-2 text-sm"
        >
          Sign in to Rental Manager
        </a>
      </div>
    );
  return <>{children}</>;
}
