import type { WebsiteVerification } from "../../convex/lib/websiteVerification";

export function websiteVerificationLabel(snapshot: Pick<WebsiteVerification, "approved" | "documentsApproved"> | null | undefined): string {
  return snapshot?.approved ? "Verification and security checks passed · confirm collection readiness" : snapshot?.documentsApproved ? "Documents approved · check security requirements" : "Paid · awaiting verification";
}
