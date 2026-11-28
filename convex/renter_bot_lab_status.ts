"use node";

import { v } from "convex/values";
import { api, internal } from "./_generated/api";
import { action } from "./owner_functions";
import { renterBotDraftEndpoint } from "./lib/renter_bot_draft_endpoint";
import { RENTER_BOT_LAB_BACKEND_SOURCE_REVISION } from "./lib/renter_bot_lab_build_revision";
import { RENTER_BOT_LAB_API_CONTRACT_VERSION } from "./lib/renter_bot_lab_contract";

type LabDraftStatusProbe = {
  ready: boolean;
  chat_action_registered: boolean;
  api_contract_version: string;
  backend_source_revision: string;
  draft_api_contract_version: string | null;
  draft_api_source_revision: string | null;
  catalog_ready: boolean;
  catalog_status: string;
  catalog_fetched_at: number | null;
  catalog_inventory_count: number;
  catalog_listing_count: number;
  catalog_eligible_listing_count: number;
  catalog_blocked_listing_count: number;
};

/** Read-only check for the hosted Lab's isolated draft connection. */
export const checkDraftAuth = action({
  args: { expectedMarker: v.string() },
  handler: async (ctx, { expectedMarker }): Promise<LabDraftStatusProbe> => {
    let endpointReady = false;
    let chatActionRegistered = false;
    let draftApiContractVersion: string | null = null;
    let draftApiSourceRevision: string | null = null;
    let catalogReady = true;
    let catalogStatus = "not_applicable";
    let catalogFetchedAt: number | null = null;
    let catalogInventoryCount = 0;
    let catalogListingCount = 0;
    let catalogEligibleListingCount = 0;
    let catalogBlockedListingCount = 0;
    try {
      const endpoint = renterBotDraftEndpoint("__probe__lab-status", {
        RENTER_BOT_LAB_API_BASE_URL: process.env.RENTER_BOT_LAB_API_BASE_URL,
        RENTER_BOT_LAB_API_SECRET: process.env.RENTER_BOT_LAB_API_SECRET,
      });
      const response = await fetch(endpoint.url, {
        method: "GET",
        headers: { Authorization: endpoint.authorization, "X-Renter-Bot-Lab": "true" },
        cache: "no-store",
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) {
        const probe = await response.json() as { api_contract_version?: unknown; source_revision?: unknown };
        draftApiContractVersion = typeof probe.api_contract_version === "string" ? probe.api_contract_version : null;
        draftApiSourceRevision = typeof probe.source_revision === "string" ? probe.source_revision : null;
        endpointReady = draftApiContractVersion === RENTER_BOT_LAB_API_CONTRACT_VERSION && !!draftApiSourceRevision;
      }
    } catch { /* status stays unready until the isolated route is configured */ }
    if (process.env.RENTER_BOT_LAB_DEPLOYMENT === "local") {
      catalogReady = false;
      catalogStatus = "unavailable";
      try {
        const catalog = await ctx.runQuery(internal.renter_bot_lab_local_setup.getCatalogStatus, {});
        catalogStatus = catalog.status;
        catalogFetchedAt = catalog.fetched_at;
        catalogInventoryCount = catalog.inventory_count;
        catalogListingCount = catalog.listing_count;
        catalogEligibleListingCount = catalog.eligible_listing_count;
        catalogBlockedListingCount = catalog.blocked_listing_count;
        catalogReady = catalog.status === "ready" && typeof catalog.fetched_at === "number" &&
          Date.now() - catalog.fetched_at <= 48 * 60 * 60 * 1000 && catalog.inventory_count > 0 && catalog.listing_count > 0;
      } catch { /* keep the Lab closed when its local source catalogue cannot be read */ }
    }
    if (endpointReady && process.env.RENTER_BOT_LAB_AUTH_CONFIG_VERSION === expectedMarker) {
      try {
        const probe = await ctx.runAction(api.renter_bot_lab_actions.runTestTurn, {
          auth_marker: expectedMarker,
          threadId: "__probe__lab-readiness",
          accountSlug: "dbcinema",
          text: "readiness probe",
          turnId: "lab-readiness-probe",
          readinessProbe: true,
        }) as { status?: unknown };
        chatActionRegistered = probe.status === "ready";
      } catch { /* a missing, stale, or incompatible chat action keeps the Lab unready */ }
    }
    return {
      ready: endpointReady && chatActionRegistered && catalogReady && process.env.RENTER_BOT_LAB_AUTH_CONFIG_VERSION === expectedMarker,
      chat_action_registered: chatActionRegistered,
      api_contract_version: RENTER_BOT_LAB_API_CONTRACT_VERSION,
      backend_source_revision: RENTER_BOT_LAB_BACKEND_SOURCE_REVISION,
      draft_api_contract_version: draftApiContractVersion,
      draft_api_source_revision: draftApiSourceRevision,
      catalog_ready: catalogReady,
      catalog_status: catalogStatus,
      catalog_fetched_at: catalogFetchedAt,
      catalog_inventory_count: catalogInventoryCount,
      catalog_listing_count: catalogListingCount,
      catalog_eligible_listing_count: catalogEligibleListingCount,
      catalog_blocked_listing_count: catalogBlockedListingCount,
    };
  },
});
