/**
 * Wave 4.7 — model auto-upgrade advisories data accessor.
 *
 * Reads from Convex `model_upgrade_scans`. Used by the
 * `get_model_upgrade_advisories` Mastra tool on the dashboard agent.
 */
import "server-only";
import { getConvex } from "./client";
import { api } from "@/../convex/_generated/api";

export interface AdvisoryRow {
  _id: string;
  scannedAt: number;
  currentModel: string;
  availableModels: string[];
  recommendedModel: string | null;
  errorMessage: string | null;
}

export async function getOpenAdvisories(): Promise<AdvisoryRow[]> {
  const cx = getConvex();
  const rows = await cx.query(api.model_upgrade_scans.listOpenAdvisories, {});
  return (rows ?? []) as unknown as AdvisoryRow[];
}
