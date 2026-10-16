import { useSyncExternalStore } from "react";
const subscribe = (fn: () => void) => {
  window.addEventListener("popstate", fn);
  window.addEventListener("qa-navigation", fn);
  return () => { window.removeEventListener("popstate", fn); window.removeEventListener("qa-navigation", fn); };
};
const snapshot = () => (window as any).__frozenSearchParams ?? window.location.search;
// Next patches history changes so useSearchParams also sees closeModal's
// replaceState. Mirror that behavior in the isolated router.
for (const method of ["pushState", "replaceState"] as const) {
  const original = window.history[method].bind(window.history);
  window.history[method] = (data: unknown, unused: string, url?: string | URL | null) => {
    original(data, unused, url);
    window.dispatchEvent(new Event("qa-navigation"));
  };
}
const navigate = (url: string, replace = false) => {
  window.history[replace ? "replaceState" : "pushState"]({}, "", url);
};
const router = { push: (url: string) => navigate(url), replace: (url: string) => navigate(url, true) };
export const useRouter = () => router;
export function useSearchParams() {
  return new URLSearchParams(useSyncExternalStore(subscribe, snapshot, snapshot));
}
