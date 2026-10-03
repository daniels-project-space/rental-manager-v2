export const OWNER_SERVICE_ISSUER = "urn:rental-manager:deployment-service";
export const OWNER_SERVICE_SUBJECT = "rental-manager-service";

export interface OwnerIdentity { issuer: string; subject: string }
export interface OwnerBinding { auth_user_id: string }

/** Only deployment-key admin transport can assign the reserved service issuer. */
export async function authorizeOwner(
  identity: OwnerIdentity | null,
  expectedIssuer: string | undefined,
  getOwner: () => Promise<OwnerBinding | null>,
  getSessionUser: () => Promise<{ _id: string } | undefined>,
): Promise<"owner" | "service"> {
  if (identity?.issuer === OWNER_SERVICE_ISSUER && identity.subject === OWNER_SERVICE_SUBJECT) return "service";
  if (!identity || !expectedIssuer || identity.issuer !== expectedIssuer) throw new Error("OWNER_AUTH_REQUIRED");
  const owner = await getOwner();
  if (!owner || owner.auth_user_id !== identity.subject) throw new Error("OWNER_ACCESS_DENIED");
  // A cryptographically valid JWT can outlive sign-out; check the live session too.
  const user = await getSessionUser();
  if (!user || user._id !== owner.auth_user_id) throw new Error("OWNER_SESSION_EXPIRED");
  return "owner";
}

/** Temporary rollout switch, to be removed after caller migration and cutover. */
export function ownerEnforcementRequired(value: string | undefined): boolean {
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new Error("Invalid OWNER_AUTH_REQUIRED configuration");
}
