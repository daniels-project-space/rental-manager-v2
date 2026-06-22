"use client";
import { useEffect, useState, useCallback } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import { SkeletonBlock } from "@/components/ui/SkeletonBlock";

// Manage live Hygglo listings (price, published, category, opening times) for a
// porting account, via the VPS listings API (proxied by /api/listings/*).

const MUTED = "#8b8fa3";
const TEXT = "#e4e6eb";
const ACCOUNTS = ["leo", "dbcinema"];

type Price = { days: number; price: number; pricePerDay: number };
type Item = {
  id: number; name: string; categoryId: number; isPublished: boolean;
  valuation: number; prices: Price[]; image: string | null; locations: number;
  publicUrl: string | null;
};
type Cat = { id: number; name: string };

function api(account: string, sub: string) {
  return `/api/listings/${account}/${sub}`;
}

function priceFor(prices: Price[], days: number) {
  const p = prices.find((x) => x.days === days);
  return p ? p.price : "";
}

function ListingRow({ account, it, cats, onSaved }: {
  account: string; it: Item; cats: Cat[]; onSaved: (i: Item) => void;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [p1, setP1] = useState(String(priceFor(it.prices, 1)));
  const [p3, setP3] = useState(String(priceFor(it.prices, 3)));
  const [p7, setP7] = useState(String(priceFor(it.prices, 7)));
  const [pub, setPub] = useState(it.isPublished);
  const [catName, setCatName] = useState(cats.find((c) => c.id === it.categoryId)?.name ?? "");
  const [opening, setOpening] = useState("");

  async function save() {
    setSaving(true); setMsg(null);
    const body: Record<string, unknown> = {};
    const prices: Price[] = [];
    const mk = (days: number, v: string) => {
      const total = Number(v);
      if (v !== "" && !Number.isNaN(total)) prices.push({ days, price: total, pricePerDay: total / days });
    };
    mk(1, p1); mk(3, p3); mk(7, p7);
    if (prices.length) body.prices = prices;
    if (pub !== it.isPublished) body.isPublished = pub;
    const cat = cats.find((c) => c.name === catName);
    if (cat && cat.id !== it.categoryId) body.categoryId = cat.id;
    if (opening.trim()) body.openingTimes = opening.trim();
    if (Object.keys(body).length === 0) { setMsg("no changes"); setSaving(false); return; }
    try {
      const r = await fetch(api(account, `item/${it.id}`), {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const d = await r.json();
      if (d?.ok) {
        setMsg("saved ✓");
        const fresh = await (await fetch(api(account, `item/${it.id}`))).json();
        onSaved({ ...it, categoryId: fresh.categoryId, isPublished: fresh.isPublished,
          prices: (fresh.prices || []).filter((x: Price) => x.price != null) });
      } else {
        setMsg("error: " + (d?.error || d?.status || "unknown"));
      }
    } catch (e) {
      setMsg("error: " + String(e));
    }
    setSaving(false);
  }

  return (
    <div className="rounded-lg" style={{ background: "rgba(255,255,255,0.03)" }}>
      <div className="flex items-center justify-between px-3 py-2 gap-2 cursor-pointer" onClick={() => setOpen((v) => !v)}>
        <div className="flex items-center gap-2 min-w-0">
          <span className="w-2 h-2 rounded-full" style={{ background: it.isPublished ? "#22c55e" : "#6b7280" }} />
          <span className="text-xs truncate" style={{ color: TEXT }}>{it.name}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0 text-[11px]" style={{ color: MUTED }}>
          <span>£{priceFor(it.prices, 1) || "?"}/d</span>
          <span>{it.locations} loc</span>
          <span>#{it.id}</span>
        </div>
      </div>
      {open && (
        <div className="px-3 pb-3 pt-1 space-y-2 border-t" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
          <div className="grid grid-cols-3 gap-2">
            {[["1-day £", p1, setP1], ["3-day £", p3, setP3], ["7-day £", p7, setP7]].map(([lbl, v, set]: any) => (
              <label key={lbl} className="text-[10px]" style={{ color: MUTED }}>
                {lbl}
                <input value={v} onChange={(e) => set(e.target.value)} inputMode="decimal"
                  className="w-full mt-0.5 px-2 py-1 rounded text-xs" style={{ background: "rgba(0,0,0,0.3)", color: TEXT }} />
              </label>
            ))}
          </div>
          <label className="text-[10px] block" style={{ color: MUTED }}>
            Category
            <input list="rm-cats" value={catName} onChange={(e) => setCatName(e.target.value)}
              className="w-full mt-0.5 px-2 py-1 rounded text-xs" style={{ background: "rgba(0,0,0,0.3)", color: TEXT }} />
          </label>
          <label className="text-[10px] block" style={{ color: MUTED }}>
            Opening times (added to description)
            <input value={opening} onChange={(e) => setOpening(e.target.value)} placeholder="e.g. Mon-Fri 9am-6pm, pickup by appointment"
              className="w-full mt-0.5 px-2 py-1 rounded text-xs" style={{ background: "rgba(0,0,0,0.3)", color: TEXT }} />
          </label>
          <div className="flex items-center justify-between">
            <label className="flex items-center gap-1.5 text-xs" style={{ color: TEXT }}>
              <input type="checkbox" checked={pub} onChange={(e) => setPub(e.target.checked)} /> Published
            </label>
            <div className="flex items-center gap-2">
              {msg && <span className="text-[11px]" style={{ color: msg.startsWith("error") ? "#ef4444" : "#22c55e" }}>{msg}</span>}
              <button onClick={save} disabled={saving}
                className="text-xs px-3 py-1 rounded-lg" style={{ background: "#2563eb", color: "#fff", opacity: saving ? 0.6 : 1 }}>
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function ListingManagerPanel() {
  const [account, setAccount] = useState("leo");
  const [items, setItems] = useState<Item[] | null>(null);
  const [cats, setCats] = useState<Cat[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");

  const load = useCallback(async (acct: string) => {
    setItems(null); setErr(null);
    try {
      const [iR, cR] = await Promise.all([
        fetch(api(acct, "items"), { cache: "no-store" }),
        fetch(api(acct, "categories"), { cache: "no-store" }),
      ]);
      if (!iR.ok) throw new Error("items HTTP " + iR.status);
      const its = await iR.json();
      setItems(Array.isArray(its) ? its : []);
      setCats(cR.ok ? await cR.json() : []);
    } catch (e) {
      setErr(String(e));
    }
  }, []);

  useEffect(() => { load(account); }, [account, load]);

  const filtered = (items || []).filter((i) => i.name?.toLowerCase().includes(q.toLowerCase()));

  return (
    <Card>
      <CardHeader
        title="Listing Manager"
        badge={<span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: "rgba(37,99,235,0.18)", color: "#6ea8fe" }}>Hygglo live</span>}
        actions={
          <select value={account} onChange={(e) => setAccount(e.target.value)}
            className="text-xs px-2 py-1 rounded-lg" style={{ background: "rgba(255,255,255,0.06)", color: TEXT }}>
            {ACCOUNTS.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        }
      />
      <datalist id="rm-cats">{cats.map((c) => <option key={c.id} value={c.name} />)}</datalist>

      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search listings…"
        className="w-full mb-3 px-3 py-1.5 rounded-lg text-sm" style={{ background: "rgba(0,0,0,0.3)", color: TEXT }} />

      {err && <div className="text-xs p-3 rounded-lg" style={{ background: "rgba(239,68,68,0.1)", color: "#ef4444" }}>
        {err} — check Hygglo vault credentials for this account.
      </div>}
      {!items && !err && <div className="space-y-2">{[...Array(5)].map((_, i) => <SkeletonBlock key={i} className="h-9 rounded-lg" />)}</div>}
      {items && (
        <>
          <div className="text-[11px] mb-2" style={{ color: MUTED }}>
            {filtered.length} of {items.length} listings · {items.filter((i) => i.isPublished).length} published · edit price / publish / category / opening times
          </div>
          <div className="space-y-1.5 max-h-[520px] overflow-y-auto pr-1">
            {filtered.slice(0, 200).map((it) => (
              <ListingRow key={it.id} account={account} it={it} cats={cats}
                onSaved={(u) => setItems((prev) => (prev || []).map((x) => (x.id === u.id ? u : x)))} />
            ))}
          </div>
          {filtered.length > 200 && <div className="text-[11px] mt-2" style={{ color: MUTED }}>Showing first 200 — refine search.</div>}
        </>
      )}
    </Card>
  );
}
