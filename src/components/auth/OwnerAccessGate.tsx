"use client";
import { Component, useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { useConvexAuth, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { authClient } from "@/lib/auth-client";
import { ownerLoginHref } from "@/lib/owner-navigation";

class AccessFailure extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return <main className="flex min-h-screen items-center justify-center bg-[#070910] px-6 text-white">
      <div className="max-w-sm space-y-4 rounded-2xl border border-white/10 bg-white/5 p-7">
        <h1 className="text-xl font-semibold">Unable to load your private dashboard</h1>
        <p className="text-sm text-white/65">Try again, or sign in again if your session has expired.</p>
        <button onClick={() => window.location.reload()} className="rounded-lg bg-blue-600 px-4 py-2">Try again</button>
        <a href="/login" onClick={event => { event.preventDefault(); window.location.assign(ownerLoginHref(window.location.pathname + window.location.search + window.location.hash)); }} className="ml-4 text-sm underline">Sign in</a>
      </div>
    </main>;
  }
}

function OwnerSession({ enforce, children }: { enforce: boolean; children: ReactNode }) {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const owner = useQuery(api.auth.state, isAuthenticated ? {} : "skip");
  const ready = !isLoading && (!isAuthenticated || owner !== undefined);
  const approved = !isLoading && isAuthenticated && owner?.authenticated === true && owner.isOwner === true;
  const [signingOut, setSigningOut] = useState(false), [error, setError] = useState("");
  useEffect(() => {
    if (enforce && ready && !approved)
      window.location.replace(ownerLoginHref(window.location.pathname + window.location.search + window.location.hash));
  }, [enforce, ready, approved]);

  async function signOut() {
    if (signingOut) return;
    setSigningOut(true); setError("");
    try {
      const result = await authClient.signOut();
      if (result.error) throw Error("Sign-out could not be confirmed. Please try again.");
      window.location.assign(ownerLoginHref(window.location.pathname + window.location.search + window.location.hash));
    } catch { setError("Sign-out could not be confirmed. Please try again."); setSigningOut(false); }
  }

  if (enforce && !approved) return <main className="flex min-h-screen items-center justify-center bg-[#070910] px-6 text-white">
    <p role="status" className="text-sm text-white/65">{ready ? "Opening sign-in…" : "Checking your owner session…"}</p>
  </main>;
  return <>
    {approved && <div className="flex flex-wrap items-center justify-end gap-3 border-b border-white/10 bg-[#070910] px-4 py-2 text-xs text-white/65">
      <span>Owner account</span>
      <button type="button" onClick={signOut} disabled={signingOut} className="rounded-md border border-white/20 px-3 py-1.5 text-white disabled:opacity-50">{signingOut ? "Signing out…" : "Sign out"}</button>
      {error && <p role="alert" className="text-red-300">{error}</p>}
    </div>}
    {children}
  </>;
}

/** Login must mount only authentication, before any operational provider queries. */
export function OwnerAccessGate({ enforce, children, login }: { enforce: boolean; children: ReactNode; login: ReactNode }) {
  const pathname = usePathname();
  if (pathname === "/login" || pathname === "/login/") return login;
  return <AccessFailure><OwnerSession enforce={enforce}>{children}</OwnerSession></AccessFailure>;
}
