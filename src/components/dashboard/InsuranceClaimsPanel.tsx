"use client";
import { Card, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";

export function InsuranceClaimsPanel() {
  return (
    <Card>
      <CardHeader title="Insurance Claims Panel" />
      <EmptyState message="Wiring scheduled for next session" icon="🛡️" />
    </Card>
  );
}
