/** Probe one protected lifecycle page. Never return records, credentials or provider errors.
 * @param {string} websiteUrl
 * @param {string|null} token
 * @param {typeof fetch} fetcher
 */
export async function checkWebsiteReader(websiteUrl, token, fetcher = fetch) {
  const unavailable = { status: 'unavailable', authenticated: null, validPage: false };
  if (!/^https:\/\/[a-z0-9-]+\.convex\.cloud$/.test(websiteUrl)) return unavailable;
  if (!token) return { status: 'missing-credential', authenticated: false, validPage: false };
  try {
    const response = await fetcher(`${websiteUrl}/api/query`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ path: 'rmv2_sync:forRmv2SyncPage', args: { token, paginationOpts: { cursor: null, numItems: 1 } }, format: 'json' }),
    });
    if (response.status === 401 || response.status === 403) return { status: 'unauthorized', authenticated: false, validPage: false };
    if (!response.ok) return unavailable;
    const result = await response.json();
    if (result?.status === 'error') {
      const code = result.errorData?.code;
      const unauthorized = ['UNAUTHORIZED', 'UNAUTHENTICATED'].includes(code) || /unauthorized|unauthenticated/i.test(String(result.errorMessage ?? ''));
      return unauthorized ? { status: 'unauthorized', authenticated: false, validPage: false } : unavailable;
    }
    const page = result?.value;
    if (result?.status !== 'success' || page?.authorized !== true || !Array.isArray(page.bookings) || page.bookings.length > 1 ||
        typeof page.isDone !== 'boolean' || typeof page.continueCursor !== 'string')
      return { status: 'invalid-contract', authenticated: null, validPage: false };
    return { status: 'ready', authenticated: true, validPage: true };
  } catch { return unavailable; }
}
