export default function Home() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-zinc-950 text-zinc-100">
      <div className="max-w-xl px-8 py-12 text-center">
        <h1 className="text-4xl font-semibold tracking-tight mb-4">Rental Manager v2</h1>
        <p className="text-zinc-400 mb-6">
          Phase 0 scaffold. Convex + Vercel + Trigger + Mastra + Stagehand wiring in progress.
        </p>
        <div className="inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-300">
          <span className="h-2 w-2 rounded-full bg-emerald-400" />
          <span>READ-ONLY mode — ALLOW_HYGGLO_SEND = false</span>
        </div>
      </div>
    </main>
  );
}
