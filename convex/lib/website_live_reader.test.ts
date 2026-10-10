import { beforeAll, afterAll, it, expect } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { checkWebsiteReader } from '../../scripts/lib/website-live-reader.mjs';
let endpoint: string;
let payload: unknown = { status: 'success', value: { authorized: true, bookings: [{ customer: 'private record' }], isDone: true, continueCursor: 'cursor' } };
let status = 200;
let malformed = false;
const requests: { method?: string; body: any }[] = [];
const server = createServer((req, res) => {
  let body = ''; req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    requests.push({ method: req.method, body: JSON.parse(body) });
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(malformed ? 'invalid response' : JSON.stringify(payload));
  });
});
beforeAll(async () => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`; });
afterAll(async () => { const closed = new Promise<void>(resolve => server.close(() => resolve())); server.closeAllConnections(); await closed; });
const transport: typeof fetch = (_url, options) => fetch(endpoint, options);
it('reads exactly one protected lifecycle page over HTTP and returns no customer data or credential', async () => {
  const result = await checkWebsiteReader('https://fixture.convex.cloud', 'private-test-credential', transport);
  expect(result).toEqual({ status: 'ready', authenticated: true, validPage: true });
  expect(requests[0]).toEqual({ method: 'POST', body: { path: 'rmv2_sync:forRmv2SyncPage', args: { token: 'private-test-credential', paginationOpts: { cursor: null, numItems: 1 } }, format: 'json' } });
  expect(JSON.stringify(result)).not.toMatch(/private-test-credential|private record|cursor/);
});
it('recognizes structured authentication failure without disclosing its private error', async () => {
  payload = { status: 'error', errorMessage: 'Opaque provider error', errorData: { code: 'UNAUTHORIZED', detail: 'private-test-credential' } };
  expect(await checkWebsiteReader('https://fixture.convex.cloud', 'private-test-credential', transport)).toEqual({ status: 'unauthorized', authenticated: false, validPage: false });
  status = 403;
  expect((await checkWebsiteReader('https://fixture.convex.cloud', 'private-test-credential', transport)).status).toBe('unauthorized');
});
it('stops on missing functions, outage, bad JSON and malformed or unbounded pages', async () => {
  status = 200; payload = { status: 'error', errorMessage: 'Function unavailable' };
  expect((await checkWebsiteReader('https://fixture.convex.cloud', 'key', transport)).status).toBe('unavailable');
  status = 503;
  expect((await checkWebsiteReader('https://fixture.convex.cloud', 'key', transport)).status).toBe('unavailable');
  status = 200; malformed = true;
  expect((await checkWebsiteReader('https://fixture.convex.cloud', 'key', transport)).status).toBe('unavailable');
  malformed = false;
  for (const value of [{ bookings: [] }, { authorized: true, bookings: [{}, {}], isDone: true, continueCursor: 'cursor' }, { authorized: true, bookings: [], isDone: false, continueCursor: 3 }, { page: [], isDone: true, continueCursor: 'cursor' }, { authorized: false, bookings: [], isDone: true, continueCursor: 'cursor' }]) {
    payload = { status: 'success', value };
    expect((await checkWebsiteReader('https://fixture.convex.cloud', 'key', transport)).status).toBe('invalid-contract');
  }
});
it('does not send credentials to an unapproved origin or run without a credential', async () => {
  const count = requests.length;
  expect((await checkWebsiteReader('https://evil.invalid', 'key', transport)).status).toBe('unavailable');
  expect((await checkWebsiteReader('https://fixture.convex.cloud', null, transport)).status).toBe('missing-credential');
  expect(requests.length).toBe(count);
});
