"use client";
import { ConvexProvider } from "convex/react";
import { convex } from "@/lib/convex";
import { AccountProvider } from "@/lib/account-context";
import { EditModeProvider } from "@/lib/dashboard/edit-mode-context";

export function Providers({ children }: { children: React.ReactNode }) {
  const client = convex;
  return (
    <ConvexProvider client={client}>
      <AccountProvider>
        <EditModeProvider>{children}</EditModeProvider>
      </AccountProvider>
    </ConvexProvider>
  );
}
