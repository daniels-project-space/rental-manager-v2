/**
 * /walle-preview — dev-only preview page for the WallE widget.
 *
 * Gated behind NODE_ENV !== 'production' (returns 404 in prod). Provides a
 * 2x2-cell-sized container around the actual <WallE /> component so we can
 * iterate on visuals without dashboard auth.
 */
"use client";

import { notFound } from "next/navigation";
import nextDynamic from "next/dynamic";

const WallE = nextDynamic(() => import("@/components/dashboard/WallE/WallE"), {
  ssr: false,
});

export default function WallePreviewPage() {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }
  return (
    <main className="min-h-screen w-full bg-[#070910] flex flex-col items-center justify-center gap-6 p-6">
      <h1 className="text-zinc-400 text-sm tracking-wider uppercase">
        WallE Preview — 2×2 cell (590×296)
      </h1>
      <div
        style={{ width: 590, height: 296 }}
        className="rounded-[1rem] overflow-hidden"
      >
        <WallE accountSlug={null} />
      </div>
      <div className="text-[11px] text-zinc-600 max-w-[590px] text-center">
        Dev-only preview. Mood + signal data may be empty without auth — visuals
        will still render. Idle scheduler runs locally.
      </div>
    </main>
  );
}
