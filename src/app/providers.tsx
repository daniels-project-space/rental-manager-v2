"use client";
import { ConvexBetterAuthProvider } from "@convex-dev/better-auth/react";
import { authClient } from "@/lib/auth-client";
import { convex } from "@/lib/convex";
import { AccountProvider } from "@/lib/account-context";
import { EditModeProvider } from "@/lib/dashboard/edit-mode-context";

export function Providers({ children }: { children: React.ReactNode }) {
  const client = convex;
  return (
    <ConvexBetterAuthProvider client={client} authClient={authClient}>
      <AccountProvider>
        <EditModeProvider>{children}</EditModeProvider>
      </AccountProvider>
    </ConvexBetterAuthProvider>
  );
}
