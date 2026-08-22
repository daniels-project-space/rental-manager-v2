import { describe, it, expect } from "vitest";
import { tokenize, rankByName, bestMatch, substitutionScore, sameMount } from "./item_name_match";

const ITEMS = [
  { name: "BMPCC 6K Pro", kind: "camera", lens_mount: "Canon EF mount" },
  { name: "BMPCC 6K Full Frame", kind: "camera", lens_mount: "Leica L-mount (native)" },
  { name: "Sony A7 III", kind: "camera", lens_mount: "Sony E-mount (full frame)" },
  { name: "Sony FX3", kind: "camera", lens_mount: "Sony E-mount (full frame)" },
  { name: "Canon EF 24-105mm f4", kind: "lens", lens_mount: "Canon EF mount" },
];

describe("tokenize", () => {
  it("KEEPS variant words that distinguish two bodies", () => {
    // The original bug: "pro"/"full"/"frame" were stopwords, so these two
    // cameras were indistinguishable.
    expect(tokenize("BMPCC 6K Pro").has("pro")).toBe(true);
    expect(tokenize("BMPCC 6K Full Frame").has("full")).toBe(true);
    expect(tokenize("BMPCC 6K Full Frame").has("frame")).toBe(true);
  });

  it("unifies roman numerals with digits", () => {
    expect(tokenize("Sony A7 III")).toEqual(tokenize("Sony A7 3"));
  });

  it("drops only true filler", () => {
    expect(tokenize("Nanlite Forza 300 (like Aputure)").has("like")).toBe(false);
  });
});

describe("rankByName — the BMPCC Pro vs Full Frame regression", () => {
  it("ranks the EXACT body above the sibling body", () => {
    const ranked = rankByName("BMPCC 6K Pro", ITEMS, (i) => i.name);
    expect(ranked[0].item.name).toBe("BMPCC 6K Pro");
    // and the sibling must score strictly lower, not tie
    const sibling = ranked.find((r) => r.item.name === "BMPCC 6K Full Frame")!;
    expect(ranked[0].score).toBeGreaterThan(sibling.score);
  });

  it("reports the missing discriminating token for the sibling", () => {
    const ranked = rankByName("BMPCC 6K Pro", ITEMS, (i) => i.name);
    const sibling = ranked.find((r) => r.item.name === "BMPCC 6K Full Frame")!;
    expect(sibling.missing).toContain("pro");
  });
});

describe("rankByName — the lookup_pricing bundle false-match", () => {
  // The live bug: querying the bare body scored a PERFECT 1.0 against a fat
  // bundle listing, because the listing's "Rode video mic PRO plus" supplied
  // the "pro" token. Coverage said 1.0; Jaccard must not.
  const LISTINGS = [
    { name: "Blackmagic cinema camera full frame 6k Bmpcc + Rode video mic pro plus microphone + tripod smallrig interview set" },
    { name: "BMPCC 6K Pro cinema camera" },
  ];

  it("does NOT let an accessory's 'pro' win the match for the bare body", () => {
    const ranked = rankByName("BMPCC 6K Pro", LISTINGS, (l) => l.name);
    expect(ranked[0].item.name).toBe("BMPCC 6K Pro cinema camera");
  });

  it("scores the fat bundle well below a tight match", () => {
    const ranked = rankByName("BMPCC 6K Pro", LISTINGS, (l) => l.name);
    const bundle = ranked.find((r) => r.item.name.startsWith("Blackmagic cinema"))!;
    expect(bundle.score).toBeLessThan(0.4);
  });
});

describe("bestMatch confidence gate", () => {
  it("is confident on a fully-covered unique match", () => {
    const r = bestMatch("BMPCC 6K Pro", ITEMS, (i) => i.name);
    expect(r.match?.name).toBe("BMPCC 6K Pro");
    expect(r.confident).toBe(true);
  });

  it("is NOT confident when the query cannot distinguish two bodies", () => {
    // "BMPCC 6K" genuinely matches both — the bot must ask, not guess.
    const r = bestMatch("BMPCC 6K", ITEMS, (i) => i.name);
    expect(r.confident).toBe(false);
    expect(r.ambiguousWith.length).toBeGreaterThan(0);
  });

  it("is not confident when a query token is missing entirely", () => {
    const r = bestMatch("BMPCC 6K Pro Mark II", ITEMS, (i) => i.name);
    expect(r.confident).toBe(false);
  });
});

describe("substitutionScore — stop cross-brand nonsense", () => {
  const target = ITEMS[0]; // BMPCC 6K Pro, Canon EF

  it("prefers the sibling Blackmagic body over a Sony body", () => {
    const sibling = substitutionScore(target, ITEMS[1]); // BMPCC 6K Full Frame
    const sony = substitutionScore(target, ITEMS[2]); // Sony A7 III
    expect(sibling).toBeGreaterThan(sony);
  });

  it("rewards a shared lens mount", () => {
    const sameMount = substitutionScore(
      { name: "BMPCC 6K Pro", kind: "camera", lens_mount: "Canon EF mount" },
      { name: "Canon C70", kind: "camera", lens_mount: "Canon EF mount" },
    );
    const diffMount = substitutionScore(
      { name: "BMPCC 6K Pro", kind: "camera", lens_mount: "Canon EF mount" },
      { name: "Canon C70", kind: "camera", lens_mount: "Sony E-mount (full frame)" },
    );
    expect(sameMount).toBeGreaterThan(diffMount);
  });

  it("never rates a different category as a substitute above the same category", () => {
    const camera = substitutionScore(target, ITEMS[1]);
    const lens = substitutionScore(target, ITEMS[4]);
    expect(camera).toBeGreaterThan(lens);
  });
});

describe("normalizeMount / sameMount", () => {
  it("treats the inventory's two spellings of one mount as equal", () => {
    // Live bug: BMPCC 6K Pro stores "Canon EF mount", adapters store "EF".
    // Exact compare said they were different mounts, so the bot was never
    // shown the PL-to-EF adapter and told the renter we didn't have one.
    expect(sameMount("Canon EF mount", "EF")).toBe(true);
    expect(sameMount("Sony E mount", "Sony E")).toBe(true);
    expect(sameMount("Leica L", "L mount")).toBe(true);
  });

  it("keeps genuinely different mounts apart", () => {
    expect(sameMount("Canon EF mount", "L")).toBe(false);
    expect(sameMount("PL", "EF")).toBe(false);
    expect(sameMount("Canon EF mount", "RF")).toBe(false);
  });

  it("makes no claim when either side is unknown", () => {
    expect(sameMount(null, "EF")).toBe(false);
    expect(sameMount("EF", "")).toBe(false);
  });
});
