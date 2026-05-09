"use client";
import { ConvexProvider } from "convex/react";
import { convex } from "@/lib/convex";
import { AccountProvider } from "@/lib/account-context";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ConvexProvider client={convex}>
      <AccountProvider>{children}</AccountProvider>
    </ConvexProvider>
  );
}
