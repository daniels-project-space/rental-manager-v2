"use node";
import { action, internalAction, requireOwner } from "./owner_functions";
import { internal } from "./_generated/api";
import {
  getAccountCredentials,
  getHyggloAccessToken,
  hyggloAuthHeaders,
  HYGGLO_API_BASE,
} from "../src/hygglo-core/auth";
import { PDFParse } from "pdf-parse";
import { createHash } from "node:crypto";
import { invoiceAmounts } from "./lib/finance/invoices";
async function auth(account: string) {
  return getHyggloAccessToken({
    ...(await getAccountCredentials(account)),
    accountSlug: account,
    country: "GB",
  });
}
export const discover = internalAction({
  args: {},
  handler: async (ctx) => {
    for (const account of await ctx.runQuery(internal.invoices.accounts, {})) {
      try {
        const token = await auth(account);
        const response = await fetch(
          HYGGLO_API_BASE + "/v4/my/orders/paid-out",
          {
            headers: hyggloAuthHeaders(token, "GB"),
            signal: AbortSignal.timeout(30000),
          },
        );
        if (!response.ok)
          throw Error(`Hygglo invoice list HTTP ${response.status}`);
        const rows: unknown = await response.json();
        if (!Array.isArray(rows)) throw Error("Unexpected invoice list format");
        let added = 0;
        for (let i = 0; i < rows.length; i += 100) {
          const batch = rows.slice(i, i + 100).map((r: any) => {
            if (!r.id) throw Error("Invoice source ID missing");
            return {
              id: String(r.id),
              title: Array.isArray(r.productNames)
                ? r.productNames.join(", ")
                : String(r.productNames ?? "Rental"),
              date: String(r.estimatedPayoutDate ?? ""),
              price: String(r.priceLabel ?? ""),
            };
          });
          added += await ctx.runMutation(internal.invoices.ingest, {
            account,
            rows: batch,
          });
        }
        await ctx.runMutation(internal.invoices.log, {
          account,
          message: `Discovered ${rows.length} invoices; ${added} new PDFs queued`,
          count: added,
        });
      } catch (error) {
        await ctx.runMutation(internal.invoices.log, {
          account,
          message:
            error instanceof Error &&
            /^Hygglo invoice list HTTP|^Unexpected|^Invoice source/.test(
              error.message,
            )
              ? error.message
              : "Invoice discovery failed: check account credentials/connectivity",
          count: 0,
        });
      }
    }
    await ctx.scheduler.runAfter(0, internal.invoice_sync.drain, {});
  },
});
export const syncNow = action({
  args: {},
  handler: async (ctx) => {
    await requireOwner(ctx, true);
    await ctx.scheduler.runAfter(0, internal.invoice_sync.discover, {});
    return { queued: true };
  },
});
export const drain = internalAction({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.runMutation(internal.invoices.claim, {});
    const tokens = new Map<string, string>();
    for (const row of rows) {
      let pdfId: Awaited<ReturnType<typeof ctx.storage.store>> | undefined;
      let textId: typeof pdfId;
      try {
        let token = tokens.get(row.account_slug);
        if (!token) {
          token = await auth(row.account_slug);
          tokens.set(row.account_slug, token);
        }
        const url =
          HYGGLO_API_BASE +
          "/v4/orders/" +
          encodeURIComponent(row.source_id) +
          "/invoice-pdf?token=" +
          encodeURIComponent(token);
        const response = await fetch(url, {
          headers: hyggloAuthHeaders(token, "GB"),
          redirect: "error",
          signal: AbortSignal.timeout(30000),
        });
        if (!response.ok) throw Error(`Invoice PDF HTTP ${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (
          bytes.length > 15000000 ||
          Buffer.from(bytes.subarray(0, 5)).toString() !== "%PDF-"
        )
          throw Error("Invalid or oversized PDF");
        const sha = createHash("sha256").update(bytes).digest("hex");
        pdfId = await ctx.storage.store(
          new Blob([bytes], { type: "application/pdf" }),
        );
        let text = "";
        let parseError: string | undefined;
        try {
          const parser = new PDFParse({ data: bytes });
          try {
            text = (await parser.getText()).text;
          } finally {
            await parser.destroy();
          }
          if (!text.trim())
            parseError = "No extractable text; review original PDF";
        } catch {
          parseError =
            "Text extraction failed; original PDF retained for review";
        }
        textId = await ctx.storage.store(
          new Blob([text || parseError!], { type: "text/plain;charset=utf-8" }),
        );
        const parsed = invoiceAmounts(text);
        await ctx.runMutation(internal.invoices.finish, {
          id: row._id,
          lease: row.lease_until,
          pdf: pdfId,
          text: textId,
          sha,
          verified: parsed.verified,
          amounts: parsed.amounts,
          ...(parseError ? { error: parseError } : {}),
        });
        pdfId = undefined;
        textId = undefined;
      } catch (error) {
        if (pdfId) await ctx.storage.delete(pdfId);
        if (textId) await ctx.storage.delete(textId);
        const message =
          error instanceof Error &&
          /^Invoice PDF HTTP|^Invalid or oversized|^PDF contains/.test(
            error.message,
          )
            ? error.message
            : "PDF import or extraction failed; retry available";
        await ctx.runMutation(internal.invoices.fail, {
          id: row._id,
          lease: row.lease_until,
          message,
        });
      }
    }
    if (rows.length === 3)
      await ctx.scheduler.runAfter(10000, internal.invoice_sync.drain, {});
  },
});
