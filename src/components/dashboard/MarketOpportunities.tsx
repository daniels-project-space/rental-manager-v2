"use client";
import { Card, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";

export function MarketOpportunities() {
  return (
    <Card>
      <CardHeader title="Market Opportunities" />
      <EmptyState message="Wiring scheduled for next session" icon="📊" />
    </Card>
  );
}
