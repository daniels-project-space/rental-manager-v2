"use client";
import { useEffect, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { ownerReturnTo } from "@/lib/owner-navigation";

export default function OwnerLogin() {
  const [invite, setInvite] = useState<string | null>(null);
  const [resetToken, setResetToken] = useState<string | null>(null);
  const [mode, setMode] = useState<"signin" | "forgot" | "reset" | "expired">("signin");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    const capture = () => {
      const fragment = new URLSearchParams(window.location.hash.slice(1));
      const invitation = fragment.get("invite"), reset = fragment.get("reset");
      if (!invitation && reset === null) return;
      setNotice(""); setError(""); setInvite(null); setResetToken(null);
      if (reset !== null) {
        if (!invitation && /^[A-Za-z0-9_-]{16,512}$/.test(reset)) { setResetToken(reset); setMode("reset"); }
        else setMode("expired");
      } else { setInvite(invitation); setMode("signin"); }
      // Invitation and reset bearers stay in memory, outside history and storage.
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    };
    capture();
    window.addEventListener("hashchange", capture);
    return () => window.removeEventListener("hashchange", capture);
  }, []);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    const data = new FormData(event.currentTarget);
    const form = event.currentTarget;
    const email = String(data.get("email") ?? "");
    const password = String(data.get("password") ?? "");
    try {
      if (mode === "forgot" || mode === "expired") {
        const returnTo = ownerReturnTo(new URLSearchParams(window.location.search).get("returnTo"));
        const callback = new URL("/login", window.location.origin);
        if (returnTo !== "/") callback.searchParams.set("returnTo", returnTo);
        const result = await authClient.requestPasswordReset({ email, redirectTo: callback.href });
        if (result.error) { setError("Recovery is temporarily unavailable. Please try again later."); return; }
        setNotice("If this email matches your owner account, you’ll receive a reset link. Allow a minute before trying again.");
        return;
      }
      if (mode === "reset") {
        if (!resetToken) { setMode("expired"); return; }
        if (password !== String(data.get("confirmPassword") ?? "")) { setError("The passwords don’t match."); return; }
        const result = await authClient.resetPassword({ newPassword: password, token: resetToken });
        if (result.error) {
          if (result.error.code === "INVALID_TOKEN") { setResetToken(null); setMode("expired"); setNotice(""); }
          else setError("Unable to update your password. Please try again.");
          return;
        }
        form.reset(); setResetToken(null); setMode("signin");
        setNotice("Password updated. Sign in with your new password.");
        return;
      }
      const result = invite
        ? await authClient.signUp.email({ email, password, name: "Owner" }, { headers: { "x-owner-setup-invite": invite } })
        : await authClient.signIn.email({ email, password });
      if (result.error) {
        setError(result.error.message ?? "Unable to sign in. Please try again.");
        return;
      }
      setInvite(null);
      window.location.assign(ownerReturnTo(new URLSearchParams(window.location.search).get("returnTo")));
    } catch {
      setError("Unable to connect. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return <main className="min-h-screen flex items-center justify-center bg-[#070910] px-6 text-white">
    <form onSubmit={submit} className="w-full max-w-sm space-y-5 rounded-2xl border border-white/10 bg-white/5 p-7">
      <div><h1 className="text-2xl font-semibold">{mode === "reset" ? "Choose a new password" : mode === "expired" ? "This reset link has expired" : mode === "forgot" ? "Reset your owner password" : invite ? "Set up your owner account" : "Sign in to Rental Manager"}</h1>
        <p className="mt-2 text-sm text-white/65">{mode === "reset" ? "Use at least 12 characters. Your existing sessions will be signed out." : mode === "forgot" || mode === "expired" ? "Enter your owner email to request a fresh, single-use link." : invite ? "Choose your email and a password of at least 12 characters. This private invitation can set up one owner." : "Use your private owner account."}</p></div>
      {mode !== "reset" && <label className="block text-sm">Email<input name="email" type="email" autoComplete="email" required disabled={busy} className="mt-2 w-full rounded-lg border border-white/20 bg-black/30 p-3" /></label>}
      {(mode === "signin" || mode === "reset") && <label className="block text-sm">{mode === "reset" ? "New password" : "Password"}<input name="password" type="password" autoComplete={invite || mode === "reset" ? "new-password" : "current-password"} minLength={invite || mode === "reset" ? 12 : undefined} maxLength={128} required disabled={busy} className="mt-2 w-full rounded-lg border border-white/20 bg-black/30 p-3" /></label>}
      {mode === "reset" && <label className="block text-sm">Confirm new password<input name="confirmPassword" type="password" autoComplete="new-password" minLength={12} maxLength={128} required disabled={busy} className="mt-2 w-full rounded-lg border border-white/20 bg-black/30 p-3" /></label>}
      {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
      {notice && <p role="status" className="text-sm text-white/75">{notice}</p>}
      <button disabled={busy} type="submit" className="w-full rounded-lg bg-blue-600 p-3 font-medium disabled:opacity-50">{busy ? "Please wait…" : mode === "reset" ? "Save new password" : mode === "forgot" || mode === "expired" ? "Send reset link" : invite ? "Create owner account" : "Sign in"}</button>
      {!invite && <button type="button" disabled={busy} onClick={() => { setMode(mode === "signin" ? "forgot" : "signin"); setResetToken(null); setError(""); setNotice(""); }} className="w-full text-sm text-white/65 underline">{mode === "signin" ? "Forgot password?" : "Back to sign in"}</button>}
    </form>
  </main>;
}
