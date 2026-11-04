import type { WebsiteVerification } from "../../convex/lib/websiteVerification";

export function websiteVerificationLabel(snapshot: Pick<WebsiteVerification, "approved" | "documentsApproved"> | null | undefined): string {
  if (!snapshot) return "No website result · check website before collection";
  return snapshot?.approved ? "Last sync: checks passed · verify on website before collection" : snapshot?.documentsApproved ? "Last sync: documents approved · check website before collection" : "Last sync: verification pending · check website";
}
