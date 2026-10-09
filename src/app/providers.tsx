"use client";
import { ConvexBetterAuthProvider } from "@convex-dev/better-auth/react";
import { authClient } from "@/lib/auth-client";
import { convex } from "@/lib/convex";
import { AccountProvider } from "@/lib/account-context";
import { EditModeProvider } from "@/lib/dashboard/edit-mode-context";
import { OwnerAccessGate } from "@/components/auth/OwnerAccessGate";

export function Providers({ children, enforceOwner = false }: { children: React.ReactNode; enforceOwner?: boolean }) {
  const client = convex;
  return (
    <ConvexBetterAuthProvider client={client} authClient={authClient}>
      <OwnerAccessGate enforce={enforceOwner} login={children}>
        <AccountProvider>
          <EditModeProvider>{children}</EditModeProvider>
        </AccountProvider>
      </OwnerAccessGate>
    </ConvexBetterAuthProvider>
  );
}
