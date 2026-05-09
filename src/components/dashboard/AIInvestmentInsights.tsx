"use client";
import { Card, CardHeader } from "@/components/ui/Card";
import { SkeletonBlock } from "@/components/ui/SkeletonBlock";
import { useState } from "react";

// Static prompts / stub insights — no real AI call in 5.3.
// Phase 5.6 will wire api.ai.generateInsights action here.
const STUB_INSIGHTS = [
  {
    headline: "Bundle revenue drives 40%+ of total income",
    body: "Multi-item bundles consistently outperform single-item rentals. Consider expanding your camera + lighting bundle offering.",
  },
  {
    headline: "Weekend demand spikes 2× weekday baseline",
    body: "Pricing adjustments for Fri–Sun slots could capture significant additional revenue from high-demand periods.",
  },
  {
    headline: "Items idle >60 days represent tied-up capital",
    body: "Several items in your inventory have not been rented in 60+ days. Review the Sell Recommender for offload candidates.",
  },
  {
    headline: "Response rate correlates with booking conversion",
    body: "Accounts with >80% response rate within 4 hours show 3× higher conversion. Aim to respond within 2 hours during peak hours.",
  },
];

export function AIInvestmentInsights() {
  const [loading, setLoading] = useState(false);
  const [insights, setInsights] = useState(STUB_INSIGHTS);
  const [generatedAt] = useState(() => new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }));

  function handleRegenerate() {
    setLoading(true);
    // Simulate brief loading — full action wired in phase 5.6
    setTimeout(() => {
      setInsights([...STUB_INSIGHTS].sort(() => Math.random() - 0.5));
      setLoading(false);
    }, 800);
  }

  return (
    <Card>
      <CardHeader
        title="AI Investment Insights"
        badge={
          <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: "rgba(167,139,250,0.12)", color: "#a78bfa" }}>
            Beta
          </span>
        }
        actions={
          <button
            onClick={handleRegenerate}
            disabled={loading}
            className="text-xs px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
            style={{ background: "rgba(167,139,250,0.15)", color: "#a78bfa" }}
          >
            {loading ? "Thinking…" : "Regenerate"}
          </button>
        }
      />

      {loading ? (
        <div className="space-y-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="flex gap-3">
              <div className="w-1 rounded-full flex-shrink-0 skeleton" style={{ minHeight: 48 }} />
              <div className="flex-1 space-y-2">
                <SkeletonBlock className="h-3 w-2/3 rounded" />
                <SkeletonBlock className="h-3 w-full rounded" />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <>
          <div className="space-y-3">
            {insights.map((insight, i) => (
              <div key={i} className="flex gap-3">
                <div
                  className="w-1 rounded-full flex-shrink-0"
                  style={{ background: "#a78bfa", minHeight: 48 }}
                />
                <div>
                  <p className="text-sm font-semibold leading-snug" style={{ color: "#e4e6eb" }}>
                    {insight.headline}
                  </p>
                  <p className="text-xs mt-1 leading-relaxed" style={{ color: "#8b8fa3" }}>
                    {insight.body}
                  </p>
                </div>
              </div>
            ))}
          </div>
          <p className="text-xs mt-4 pt-3" style={{ color: "rgba(139,143,163,0.5)", borderTop: "1px solid rgba(255,255,255,0.06)" }}>
            Generated at {generatedAt} · Full AI analysis in phase 5.6
          </p>
        </>
      )}
    </Card>
  );
}
