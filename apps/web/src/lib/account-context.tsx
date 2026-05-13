"use client";
import { createContext, useContext, useEffect, useState } from "react";

type AccountSlug = string | null;

interface AccountCtx {
  activeAccountSlug: AccountSlug;
  setActiveAccountSlug: (s: AccountSlug) => void;
}

const AccountContext = createContext<AccountCtx>({
  activeAccountSlug: null,
  setActiveAccountSlug: () => {},
});

const STORAGE_KEY = "rm_account_slug";

export function AccountProvider({ children }: { children: React.ReactNode }) {
  const [activeAccountSlug, setSlug] = useState<AccountSlug>(null);

  // TODO(5.x): persist selection to Convex settings table instead of localStorage
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) setSlug(saved);
  }, []);

  function setActiveAccountSlug(s: AccountSlug) {
    setSlug(s);
    if (s) localStorage.setItem(STORAGE_KEY, s);
    else localStorage.removeItem(STORAGE_KEY);
  }

  return (
    <AccountContext.Provider value={{ activeAccountSlug, setActiveAccountSlug }}>
      {children}
    </AccountContext.Provider>
  );
}

export function useAccount() {
  return useContext(AccountContext);
}
