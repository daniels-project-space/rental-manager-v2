"use client";
import { useEffect, useState } from "react";
import { authClient } from "@/lib/auth-client";

export default function OwnerLogin() {
  const [invite, setInvite] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const token = new URLSearchParams(window.location.hash.slice(1)).get("invite");
    if (token) {
      setInvite(token);
      // The setup secret stays in memory, outside logs, history and browser storage.
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const data = new FormData(event.currentTarget);
    const email = String(data.get("email") ?? "");
    const password = String(data.get("password") ?? "");
    try {
      const result = invite
        ? await authClient.signUp.email({ email, password, name: "Owner" }, { headers: { "x-owner-setup-invite": invite } })
        : await authClient.signIn.email({ email, password });
      if (result.error) {
        setError(result.error.message ?? "Unable to sign in. Please try again.");
        return;
      }
      setInvite(null);
      window.location.assign("/");
    } catch {
      setError("Unable to connect. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return <main className="min-h-screen flex items-center justify-center bg-[#070910] px-6 text-white">
    <form onSubmit={submit} className="w-full max-w-sm space-y-5 rounded-2xl border border-white/10 bg-white/5 p-7">
      <div><h1 className="text-2xl font-semibold">{invite ? "Set up your owner account" : "Sign in to Rental Manager"}</h1>
        <p className="mt-2 text-sm text-white/65">{invite ? "Choose your email and a password of at least 12 characters. This private invitation can set up one owner." : "Use your private owner account."}</p></div>
      <label className="block text-sm">Email<input name="email" type="email" autoComplete="email" required disabled={busy} className="mt-2 w-full rounded-lg border border-white/20 bg-black/30 p-3" /></label>
      <label className="block text-sm">Password<input name="password" type="password" autoComplete={invite ? "new-password" : "current-password"} minLength={invite ? 12 : undefined} required disabled={busy} className="mt-2 w-full rounded-lg border border-white/20 bg-black/30 p-3" /></label>
      {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
      <button disabled={busy} type="submit" className="w-full rounded-lg bg-blue-600 p-3 font-medium disabled:opacity-50">{busy ? "Please wait…" : invite ? "Create owner account" : "Sign in"}</button>
    </form>
  </main>;
}
