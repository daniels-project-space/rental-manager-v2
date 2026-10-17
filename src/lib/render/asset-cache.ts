/** A process-local cache for complete immutable asset buffers. Eviction never
 * modifies bytes already returned to a caller, and large assets still load in
 * full. There is no timer or background work keeping a serverless worker alive. */
export class AssetCache {
  private entries = new Map<string, { value: Buffer; expiresAt: number }>();
  private pending = new Map<string, Promise<Buffer>>();
  private retainedBytes = 0;
  constructor(private readonly limits: { maxBytes: number; maxEntries: number; ttlMs: number }, private readonly now = Date.now) {
    if (!Number.isFinite(limits.maxBytes) || limits.maxBytes < 0 || !Number.isSafeInteger(limits.maxEntries) || limits.maxEntries < 0 || !Number.isFinite(limits.ttlMs) || limits.ttlMs <= 0) throw Error("Invalid asset cache limits");
  }
  private remove(key: string) {
    const row = this.entries.get(key);
    if (row) { this.retainedBytes -= row.value.byteLength; this.entries.delete(key); }
  }
  private expire() {
    const now = this.now();
    for (const [key, row] of this.entries) if (row.expiresAt <= now) this.remove(key);
  }
  get retained() { this.expire(); return { entries: this.entries.size, bytes: this.retainedBytes, pending: this.pending.size }; }
  async load(key: string, loader: () => Promise<Buffer>): Promise<Buffer> {
    this.expire();
    const row = this.entries.get(key);
    if (row) { this.entries.delete(key); this.entries.set(key, row); return row.value; }
    const running = this.pending.get(key);
    if (running) return running;
    const request = Promise.resolve().then(loader).then(value => {
      this.expire();
      if (value.byteLength <= this.limits.maxBytes && this.limits.maxEntries > 0) {
        // Overflow loads are deliberately not retained in the pending-key map.
        // If two finish for one key, replace its accounting before insertion.
        this.remove(key);
        while (this.entries.size && (this.entries.size >= this.limits.maxEntries || this.retainedBytes + value.byteLength > this.limits.maxBytes)) this.remove(this.entries.keys().next().value!);
        this.entries.set(key, { value, expiresAt: this.now() + this.limits.ttlMs });
        this.retainedBytes += value.byteLength;
      }
      return value;
    }).finally(() => { if (this.pending.get(key) === request) this.pending.delete(key); });
    // Excess active requests still receive full assets; the cache itself never
    // retains an unbounded list of in-flight keys.
    if (this.pending.size < Math.max(1, this.limits.maxEntries)) this.pending.set(key, request);
    return request;
  }
}
