"use client";

import { useRouter } from "next/navigation";
import { SettingsWorkspace } from "@/components/dashboard/SettingsDrawer";

/** Full-screen operational settings, intentionally separate from the dashboard grid. */
export default function SettingsPage() {
  const router = useRouter();
  return <SettingsWorkspace onBack={() => router.push("/")} />;
}
