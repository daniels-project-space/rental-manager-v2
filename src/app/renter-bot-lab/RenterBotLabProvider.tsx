"use client";

import { ConvexProvider, ConvexReactClient } from "convex/react";
import type { ReactNode } from "react";
import { useState } from "react";
import { resolveRenterBotLabBrowserUrl } from "@/lib/convex-url";

export function RenterBotLabProvider({ children }: { children: ReactNode }) {
  const labUrl = process.env.NEXT_PUBLIC_RENTER_BOT_LAB_CONVEX_URL?.trim();
  if (!labUrl) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#0b0c10] p-6 text-[#e4e6eb]">
        <p className="max-w-lg rounded-lg border border-white/10 bg-white/[0.03] p-5 text-sm leading-6 text-[#b6bac7]" role="status">
          The isolated Renter Bot Lab backend is not configured for this deployment. The Lab is unavailable here; it will not fall back to production data.
        </p>
      </main>
    );
  }
  return <ConfiguredLabProvider labUrl={labUrl}>{children}</ConfiguredLabProvider>;
}

function ConfiguredLabProvider({ labUrl, children }: { labUrl: string; children: ReactNode }) {
  const [client] = useState(() => new ConvexReactClient(resolveRenterBotLabBrowserUrl({
    NODE_ENV: process.env.NODE_ENV,
    NEXT_PUBLIC_CONVEX_URL: process.env.NEXT_PUBLIC_CONVEX_URL,
    NEXT_PUBLIC_RENTER_BOT_LAB_CONVEX_URL: labUrl,
  })));
  return <ConvexProvider client={client}>{children}</ConvexProvider>;
}
