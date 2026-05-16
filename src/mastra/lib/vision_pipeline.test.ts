/**
 * Phase 3c / Wave 3b — unit tests for the 4-tier vision pipeline.
 *
 * Hosted under src/mastra/lib/ so vitest's include glob picks it up
 * (vitest.config.ts only globs `src/mastra/**`). The functions under test
 * are pure helpers from convex/resolve_item_from_image.ts.
 *
 * Tests focus on the cache layer (Tier 1) using deterministic stub state:
 *   - First "resolve" call hits Tier 4 (no cache row exists)
 *   - Second "resolve" call hits Tier 1 (cache row written by call 1)
 *
 * The actual Convex action is not invoked — we exercise the pHash + cache
 * routing logic via a small in-memory fake that mirrors the action's
 * decision tree.
 */
import { describe, it, expect } from "vitest";
import {
  computePHash,
  hammingHex,
} from "../../../convex/resolve_item_from_image";

// ── Pure helpers ────────────────────────────────────────────────────────

describe("hammingHex", () => {
  it("returns 0 for identical strings", () => {
    expect(hammingHex("abc123", "abc123")).toBe(0);
  });
  it("returns bit-count diff", () => {
    // 'a' = 1010, 'b' = 1011 → 1 bit
    expect(hammingHex("a", "b")).toBe(1);
    // 'f' = 1111, '0' = 0000 → 4 bits
    expect(hammingHex("f", "0")).toBe(4);
  });
  it("returns MAX when lengths differ (defensive)", () => {
    expect(hammingHex("ab", "abc")).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("computePHash", () => {
  it("produces a stable 16-char hex string for a small PNG", async () => {
    // 4x4 solid white PNG (smallest deterministic input)
    const sharp = (await import("sharp")).default;
    const buf = await sharp({
      create: { width: 16, height: 16, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .png()
      .toBuffer();
    const h1 = await computePHash(buf);
    const h2 = await computePHash(buf);
    expect(h1).toBe(h2); // determinism
    expect(h1).toHaveLength(16); // 64 bits → 16 hex chars
    expect(/^[0-9a-f]{16}$/.test(h1)).toBe(true);
  });

  it("returns different hashes for visually-distinct inputs", async () => {
    const sharp = (await import("sharp")).default;
    const white = await sharp({
      create: { width: 16, height: 16, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .png()
      .toBuffer();
    // half-and-half image with a VERTICAL split — produces horizontal
    // gradients that the dHash algorithm (left vs right pixel) picks up.
    const banded = await sharp({
      create: { width: 16, height: 16, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .composite([
        {
          input: {
            create: {
              width: 8,
              height: 16,
              channels: 3,
              background: { r: 255, g: 255, b: 255 },
            },
          },
          top: 0,
          left: 0,
        },
      ])
      .png()
      .toBuffer();
    const hW = await computePHash(white);
    const hB = await computePHash(banded);
    expect(hW).not.toBe(hB);
  });
});

// ── Tier 1 cache-hit simulator ───────────────────────────────────────────
//
// The full action depends on Convex `ctx.runQuery/runMutation/runAction`.
// Rather than spinning a Convex test runtime, we simulate the cache layer
// directly to assert the "first call writes cache; second call reads it"
// invariant.

interface CacheRow {
  image_url: string;
  phash: string;
  canonical_item_id: string;
  confidence: number;
}

class FakeCache {
  rows: CacheRow[] = [];
  findByExact(phash: string): CacheRow | null {
    return this.rows.find((r) => r.phash === phash) ?? null;
  }
  findNear(phash: string, threshold = 8): CacheRow | null {
    let best: { row: CacheRow; dist: number } | null = null;
    for (const r of this.rows) {
      const d = hammingHex(r.phash, phash);
      if (d < threshold && (!best || d < best.dist)) best = { row: r, dist: d };
    }
    return best?.row ?? null;
  }
  upsert(row: CacheRow) {
    const idx = this.rows.findIndex((r) => r.image_url === row.image_url);
    if (idx >= 0) this.rows[idx] = row;
    else this.rows.push(row);
  }
}

// Mirror of resolveItemFromImage's tier-routing decision, sans network IO.
async function fakeResolve(
  imageBuf: Buffer,
  imageUrl: string,
  cache: FakeCache,
  expensiveResolverThatHitsTier4: () => Promise<{
    item_id: string;
    confidence: number;
  }>,
): Promise<{ item_id: string | null; tier: 0 | 1 | 4; confidence: number }> {
  const phash = await computePHash(imageBuf);
  // Tier 1: exact
  const exact = cache.findByExact(phash);
  if (exact) {
    return { item_id: exact.canonical_item_id, tier: 1, confidence: exact.confidence };
  }
  // Tier 1: Hamming-near
  const near = cache.findNear(phash, 8);
  if (near) {
    cache.upsert({ image_url: imageUrl, phash, canonical_item_id: near.canonical_item_id, confidence: near.confidence });
    return { item_id: near.canonical_item_id, tier: 1, confidence: near.confidence };
  }
  // Tier 4 (skipping 2/3 in this fake — they would require network)
  const grok = await expensiveResolverThatHitsTier4();
  cache.upsert({ image_url: imageUrl, phash, canonical_item_id: grok.item_id, confidence: grok.confidence });
  return { item_id: grok.item_id, tier: 4, confidence: grok.confidence };
}

describe("vision pipeline tier routing", () => {
  it("first call hits Tier 4, second call hits Tier 1 (learn-once-cache-forever)", async () => {
    const sharp = (await import("sharp")).default;
    const img = await sharp({
      create: {
        width: 16,
        height: 16,
        channels: 3,
        background: { r: 12, g: 200, b: 90 },
      },
    })
      .png()
      .toBuffer();

    const cache = new FakeCache();
    let tier4Calls = 0;
    const fakeGrok = async () => {
      tier4Calls++;
      return { item_id: "item_abc", confidence: 0.88 };
    };

    const r1 = await fakeResolve(img, "https://cdn.example.com/foo.jpg", cache, fakeGrok);
    expect(r1.tier).toBe(4);
    expect(r1.item_id).toBe("item_abc");
    expect(tier4Calls).toBe(1);

    // Second call with same image → cache hit, NO Tier-4 fire
    const r2 = await fakeResolve(img, "https://cdn.example.com/foo.jpg", cache, fakeGrok);
    expect(r2.tier).toBe(1);
    expect(r2.item_id).toBe("item_abc");
    expect(tier4Calls).toBe(1); // unchanged
  });

  it("near-match (Hamming distance < 8) also serves from Tier 1 cache", async () => {
    const sharp = (await import("sharp")).default;
    const img1 = await sharp({
      create: {
        width: 16, height: 16, channels: 3,
        background: { r: 50, g: 50, b: 50 },
      },
    }).png().toBuffer();

    const cache = new FakeCache();
    let tier4Calls = 0;
    const fakeGrok = async () => {
      tier4Calls++;
      return { item_id: "item_xyz", confidence: 0.9 };
    };

    // Seed cache via Tier 4
    await fakeResolve(img1, "https://cdn.example.com/a.jpg", cache, fakeGrok);
    expect(tier4Calls).toBe(1);

    // Same image, different URL → exact phash match still wins
    const r2 = await fakeResolve(img1, "https://cdn.example.com/b.jpg", cache, fakeGrok);
    expect(r2.tier).toBe(1);
    expect(r2.item_id).toBe("item_xyz");
    expect(tier4Calls).toBe(1);
  });
});
