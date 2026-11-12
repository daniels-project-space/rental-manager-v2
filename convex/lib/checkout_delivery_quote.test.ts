import { describe, expect, it, vi } from "vitest";
import { checkoutDeliveryQuote } from "./checkout_delivery_quote";
import { unsupportedPriceClaims } from "./price_claims";

const input = { account: "dbcinema", postcode: "SW1A 1AA", startDate: "2026-11-26", endDate: "2026-11-26", items: [{ productId: 1103089, qty: 2 }] };
const slug = "blackmagic-kit-1103089";
const start = Date.parse("2026-11-26T12:00:00Z");
const envelope = (value: unknown) => new Response(JSON.stringify({ status: "success", value }));

function fake(options: { duplicate?: boolean; bookable?: boolean; badReceipt?: boolean } = {}) {
  return vi.fn(async (_url: string, request: RequestInit) => {
    const body = JSON.parse(String(request.body));
    if (body.path === "catalog:discovery") return envelope({page: [{slug}, ...(options.duplicate ? [{slug: `other-1103089`}] : [])], isDone: true});
    if (body.path === "catalog:getListingBySlug") return envelope({ _id: "website-listing", slug, bookable: options.bookable ?? true, marketingOnly: false });
    if (body.path === "delivery:quote") return envelope({ok:true,fee:46,km:1.3,vehicle:"car",groups:[{start,end:start,fee:options.badReceipt ? 47 : 46}]});
    throw Error("unexpected request");
  });
}

describe("exact public checkout delivery receipt", () => {
  it("uses the exact account listing and preserves quantity in the checkout basket", async () => {
    const fetcher = fake();
    expect(await checkoutDeliveryQuote(input, fetcher as typeof fetch)).toEqual({fee:46,km:1.3,vehicle:"car"});
    const request = JSON.parse(String(fetcher.mock.calls[2][1].body));
    expect(request.args.groups).toEqual([{start,end:start,listingIds:["website-listing","website-listing"]}]);
  });
  it("withholds a quote for a different account, ambiguous listing, unavailable listing or mismatched receipt", async () => {
    expect(await checkoutDeliveryQuote({...input,account:"leo"}, fake() as typeof fetch)).toBeNull();
    expect(await checkoutDeliveryQuote(input, fake({duplicate:true}) as typeof fetch)).toBeNull();
    expect(await checkoutDeliveryQuote(input, fake({bookable:false}) as typeof fetch)).toBeNull();
    expect(await checkoutDeliveryQuote(input, fake({badReceipt:true}) as typeof fetch)).toBeNull();
  });
  it("withholds a quote for invalid dates or a missing full postcode", async () => {
    const fetcher = fake();
    expect(await checkoutDeliveryQuote({...input,startDate:"2026-02-30"},fetcher as typeof fetch)).toBeNull();
    expect(await checkoutDeliveryQuote({...input,postcode:"Shoreditch"},fetcher as typeof fetch)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("accepts only the verified round-trip delivery amount, never another price or a one-way claim", () => {
    const request = {items:[{name:"BMPCC 6K Full Frame",quantity:1}]};
    const check = (text:string, fee?:number) => unsupportedPriceClaims(text, [], request, "", undefined, fee);
    expect(check("Delivery and collection is £46.",46)).toEqual([]);
    expect(check("Delivery and collection is £46.")).not.toEqual([]);
    expect(check("Delivery and collection is £47.",46)).not.toEqual([]);
    expect(check("One-way delivery is £46.",46)).not.toEqual([]);
    expect(check("The camera rental is £46.",46)).not.toEqual([]);
  });
});
