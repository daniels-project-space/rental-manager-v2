/** The raw invitation is never stored in a table or exposed by a query. */
export async function validOwnerSetupInvite(token: string | null, expectedHash: string | undefined): Promise<boolean> {
  if (!token || token.length < 32 || token.length > 512 || !expectedHash || !/^[a-f0-9]{64}$/.test(expectedHash)) return false;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const actual = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
  let difference = 0;
  for (let i = 0; i < actual.length; i++) difference |= actual.charCodeAt(i) ^ expectedHash.charCodeAt(i);
  return difference === 0;
}
