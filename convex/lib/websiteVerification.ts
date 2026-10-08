import { v, type Infer } from "convex/values";

const check = v.union(v.literal("waiting"), v.literal("processing"), v.literal("approved"), v.literal("requires_input"), v.literal("review"), v.literal("rejected"));
export const websiteVerificationValidator = v.object({
  version: v.literal(1), provider: v.string(),
  status: v.union(v.literal("required"), v.literal("processing"), v.literal("manual_review"), v.literal("requires_input"), v.literal("rejected"), v.literal("verified")),
  checks: v.object({ identity: check, selfie: check, address: check }),
  accountId: v.union(v.string(), v.null()), sessionId: v.union(v.string(), v.null()), updatedAt: v.union(v.number(), v.null()),
  securityReady: v.boolean(), archiveReady: v.boolean(), requiresDroneLicence: v.boolean(), droneLicenceStatus: v.string(), approved: v.boolean(),
});
export type WebsiteVerification = Infer<typeof websiteVerificationValidator>;
const statuses = new Set(["required", "processing", "manual_review", "requires_input", "rejected", "verified"]);
const checks = new Set(["waiting", "processing", "approved", "requires_input", "review", "rejected"]);
/** Only consumed behind the authenticated website bridge, never from an owner approval form. */
export function parseWebsiteVerification(raw: unknown): WebsiteVerification | undefined {
  if (raw === undefined) return undefined;
  const x = raw as WebsiteVerification;
  const keys = ["version", "provider", "status", "checks", "accountId", "sessionId", "updatedAt", "securityReady", "archiveReady", "requiresDroneLicence", "droneLicenceStatus", "approved"];
  if (!x || typeof x !== "object" || Object.keys(x).some(k => !keys.includes(k)) || keys.some(k => !(k in x)) || x.version !== 1 || typeof x.provider !== "string" || !x.provider.trim() || !statuses.has(x.status)
    || !x.checks || typeof x.checks !== "object" || Object.keys(x.checks).length !== 3 || ![x.checks.identity,x.checks.selfie,x.checks.address].every(s => checks.has(s))
    || ![x.accountId,x.sessionId].every(s => s === null || (typeof s === "string" && !!s.trim()))
    || !(x.updatedAt === null || (Number.isFinite(x.updatedAt) && x.updatedAt >= 0))
    || ![x.securityReady,x.archiveReady,x.requiresDroneLicence,x.approved].every(s => typeof s === "boolean") || typeof x.droneLicenceStatus !== "string") throw Error("Invalid website verification snapshot");
  // An authenticated provider human review may approve checks still marked review.
  if (x.approved && (x.status !== "verified" || !x.accountId || !x.securityReady || !x.archiveReady || (x.requiresDroneLicence && x.droneLicenceStatus !== "approved"))) throw Error("Inconsistent website verification approval");
  return { ...x, checks: { ...x.checks } };
}
export function websiteVerificationLabel(snapshot: WebsiteVerification | null | undefined): string {
  return snapshot?.approved ? "Approved · ready for collection" : "Paid · awaiting verification";
}
