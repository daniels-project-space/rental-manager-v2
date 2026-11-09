"use client";

import { ConvexProvider, ConvexReactClient } from "convex/react";
import type { ReactNode } from "react";
import { useState } from "react";
import { resolveRenterBotLabBrowserUrl } from "@/lib/convex-url";

export function RenterBotLabProvider({ children }: { children: ReactNode }) {
  const [client] = useState(() => new ConvexReactClient(resolveRenterBotLabBrowserUrl({
    NODE_ENV: process.env.NODE_ENV,
    NEXT_PUBLIC_CONVEX_URL: process.env.NEXT_PUBLIC_CONVEX_URL,
    NEXT_PUBLIC_RENTER_BOT_LAB_CONVEX_URL: process.env.NEXT_PUBLIC_RENTER_BOT_LAB_CONVEX_URL,
  })));
  return <ConvexProvider client={client}>{children}</ConvexProvider>;
}
