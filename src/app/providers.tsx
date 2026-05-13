"use client";
import { ConvexProvider } from "convex/react";
import { convex } from "@/lib/convex";
import { AccountProvider } from "@/lib/account-context";

export function Providers({ children }: { children: React.ReactNode }) {
  const client = convex;
  return (
    <ConvexProvider client={client}>
      <AccountProvider>{children}</AccountProvider>
    </ConvexProvider>
  );
}
