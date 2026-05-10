"use client";
import { Card, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";

export function PortToLeo() {
  return (
    <Card>
      <CardHeader title="Port to Leo" />
      <EmptyState message="Wiring scheduled for next session" icon="🚀" />
    </Card>
  );
}
