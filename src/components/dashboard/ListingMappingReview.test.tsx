import { renderToStaticMarkup } from "react-dom/server";
import { writeFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  results: [] as unknown[],
  inventory: null as unknown,
}));

vi.mock("convex/react", () => ({
  useMutation: () => async () => ({ ok: true }),
  usePaginatedQuery: () => ({ results: mockState.results, status: "Exhausted", loadMore: () => undefined }),
  useQuery: () => mockState.inventory,
}));

import { ListingMappingReview } from "./ListingMappingReview";

describe("ListingMappingReview", () => {
  beforeEach(() => {
    mockState.inventory = {
      resolverItems: [{
        _id: "blazar-remus-100",
        name_canonical: "Anamorphic Blazar Remus 100mm",
        kind: "lens",
        qty: 1,
        unit_kind: "unit",
        status: "active",
        is_marketing_only: false,
      }],
      selectableItems: [{
        id: "blazar-remus-100",
        name: "Anamorphic Blazar Remus 100mm",
        displayName: "Blazar Remus 100mm",
        kind: "lens",
        qty: 1,
        aliases: [],
      }],
    };
    mockState.results = [
      {
        productId: 1001,
        name: "Anamorphic Blazar Remus 100mm",
        isPublished: true,
        isMarketingOnly: false,
        masterItemId: "blazar-remus-100",
        primaryItem: { id: "blazar-remus-100", name: "Anamorphic Blazar Remus 100mm", status: "active", qty: 1, marketingOnly: false },
        description: "",
        resolutionDescription: "",
        descriptionTruncated: false,
        override: null,
        revision: "null",
        mappingConflict: false,
      },
      {
        productId: 1002,
        name: "Sony FX3 mapped to retired stock",
        isPublished: true,
        isMarketingOnly: false,
        masterItemId: null,
        primaryItem: null,
        description: "",
        resolutionDescription: "",
        descriptionTruncated: false,
        override: { components: [{ item_id: "retired-fx3", qty: 1 }], note: "Legacy owner map" },
        revision: "legacy",
        mappingConflict: false,
      },
      {
        productId: 1003,
        name: "Archived listing with no DB stock",
        isPublished: false,
        isMarketingOnly: false,
        masterItemId: null,
        primaryItem: null,
        description: "",
        resolutionDescription: "",
        descriptionTruncated: false,
        override: { components: [], note: "Owner confirmed no physical stock" },
        revision: "no-stock",
        mappingConflict: false,
      },
      {
        productId: 1004,
        name: "Marketing demand listing",
        isPublished: true,
        isMarketingOnly: true,
        masterItemId: null,
        primaryItem: null,
        description: "",
        resolutionDescription: "",
        descriptionTruncated: false,
        override: null,
        revision: "null",
        mappingConflict: false,
      },
    ];
  });

  it("keeps an incomplete saved map in Needs review and exposes separate stock filters", () => {
    const html = renderToStaticMarkup(<ListingMappingReview />);
    const previewPath = process.env.LISTING_REVIEW_PREVIEW_PATH;
    if (previewPath) {
      const styles = (process.env.LISTING_REVIEW_PREVIEW_CSS ?? "")
        .split(",")
        .filter(Boolean)
        .map((href) => `<link rel="stylesheet" href="${href}">`)
        .join("");
      writeFileSync(previewPath, `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${styles}<style>body{margin:0;background:#07090e;color:#eef0f5;font-family:Arial,sans-serif}</style></head><body><main style="max-width:1180px;margin:0 auto;padding:32px">${html}</main></body></html>`);
    }
    expect(html).toContain("Resolver needs mapping review");
    expect(html).toContain("Resolver evidence · not saved");
    expect(html).toContain("Unresolved inventory item");
    expect(html).toContain("These are resolver findings, not a saved stock map.");
    expect(html).toContain("Saved owner map");
    expect(html).toContain("Edit stock map");
    expect(html).toContain("Mapped");
    expect(html).toContain("No physical stock");
    expect(html).toContain("Marketing only");
  });
});
