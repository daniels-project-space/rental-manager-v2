import { describe, it, expect } from "vitest";
import { compareQuickReplies } from "./quick_reply_sort";
const row = (thread_id: string, overrides = {}) => ({
  thread_id,
  last_sender: "renter",
  last_renter_msg_at: 100,
  last_activity_at: 100,
  request_created_at: 100,
  net_to_owner_gbp: null,
  estimate_earnings_gbp: 100,
  ...overrides,
});
describe("independent Quick Reply sorting", () => {
  it("sorts earnings without wait weighting", () => {
    expect(
      compareQuickReplies(
        row("a", { estimate_earnings_gbp: 500, last_renter_msg_at: 999 }),
        row("b", { estimate_earnings_gbp: 100, last_renter_msg_at: 1 }),
        "earnings",
        1000,
      ),
    ).toBeLessThan(0);
  });
  it("equal earnings use stable identity rather than waiting time", () => {
    expect(
      compareQuickReplies(
        row("a", { last_renter_msg_at: 999 }),
        row("b", { last_renter_msg_at: 1 }),
        "earnings",
        1000,
      ),
    ).toBeLessThan(0);
  });
  it("sorts longest unanswered wait without earnings weighting", () => {
    expect(
      compareQuickReplies(
        row("a", { last_renter_msg_at: 1, estimate_earnings_gbp: 1 }),
        row("b", { last_renter_msg_at: 999, estimate_earnings_gbp: 5000 }),
        "waiting",
        1000,
      ),
    ).toBeLessThan(0);
  });
  it("does not put answered or missing timestamps ahead of waiting renters", () => {
    for (const overrides of [
      { last_sender: "owner" },
      { last_renter_msg_at: 0 },
      { last_renter_msg_at: NaN },
    ])
      expect(
        compareQuickReplies(row("a", overrides), row("b"), "waiting", 1000),
      ).toBeGreaterThan(0);
  });
  it("oldest request is unaffected by later chat activity", () => {
    expect(
      compareQuickReplies(
        row("a", { request_created_at: 1, last_activity_at: 999 }),
        row("b", { request_created_at: 2, last_activity_at: 3 }),
        "oldest",
        1000,
      ),
    ).toBeLessThan(0);
  });
  it("uses actual payout ahead of an estimate and keeps unknown money last", () => {
    expect(
      compareQuickReplies(
        row("a", { net_to_owner_gbp: 0, estimate_earnings_gbp: 1000 }),
        row("b", { estimate_earnings_gbp: 1 }),
        "earnings",
        1000,
      ),
    ).toBeGreaterThan(0);
    expect(
      compareQuickReplies(
        row("a", { estimate_earnings_gbp: null }),
        row("b"),
        "earnings",
        1000,
      ),
    ).toBeGreaterThan(0);
  });
  it("only Priority blends stock with money and wait", () => {
    expect(
      compareQuickReplies(
        row("a", { availability: { status: "available" } }),
        row("b", { availability: { status: "conflict" } }),
        "priority",
        1000,
      ),
    ).toBeLessThan(0);
  });
});

describe("priority reply lifecycle",()=>{
 it("always places an answered high-value rental below an unanswered low-value request",()=>{
  const replied=row("high-value",{last_sender:"owner",estimate_earnings_gbp:100000,availability:{status:"available"}});
  const waiting=row("waiting",{estimate_earnings_gbp:1,availability:{status:"conflict"}});
  expect(compareQuickReplies(replied,waiting,"priority",1000)).toBeGreaterThan(0);
  expect(compareQuickReplies(waiting,replied,"priority",1000)).toBeLessThan(0);
 });
 it("moves a thread back into outstanding priority when its renter writes again",()=>{
  const a=row("a",{last_sender:"owner",estimate_earnings_gbp:100000});const b=row("b",{estimate_earnings_gbp:1});
  expect([a,b].sort((x,y)=>compareQuickReplies(x,y,"priority",1000)).map(x=>x.thread_id)).toEqual(["b","a"]);
  a.last_sender="renter";a.last_renter_msg_at=500;
  expect([a,b].sort((x,y)=>compareQuickReplies(x,y,"priority",1000)).map(x=>x.thread_id)).toEqual(["a","b"]);
 });
});

it("also keeps a new request without any messages above already answered threads",()=>expect(compareQuickReplies(row("new",{last_sender:null,last_renter_msg_at:0,estimate_earnings_gbp:1}),row("answered",{last_sender:"owner",estimate_earnings_gbp:100000}),"priority",1000)).toBeLessThan(0));

describe("section-aware live priority ranking", () => {
  it("ranks viable, higher-return rentals first inside the request section", () => {
    const available = row("available", {
      estimate_earnings_gbp: 100,
      availability: { status: "available" },
    });
    const conflict = row("conflict", {
      estimate_earnings_gbp: 1,
      availability: { status: "conflict" },
    });
    expect(compareQuickReplies(available, conflict, "priority", 1000, "requests")).toBeLessThan(0);
  });

  it("reorders the all section by earnings and availability after a reply", () => {
    const rental = row("rental", {
      estimate_earnings_gbp: 50_000,
      last_sender: "owner",
      availability: { status: "available" },
      last_renter_msg_at: 100,
    });
    const enquiry = row("enquiry", {
      estimate_earnings_gbp: 10_000,
      availability: { status: "available" },
      last_renter_msg_at: 900,
    });

    expect(compareQuickReplies(rental, enquiry, "priority", 1000, "all")).toBeGreaterThan(0);
    rental.last_sender = "renter";
    rental.last_renter_msg_at = 990;
    expect(compareQuickReplies(rental, enquiry, "priority", 1000, "all")).toBeLessThan(0);

    // The optimistic send receipt changes last_sender immediately, removing
    // stale wait urgency; the live list then recalculates from current metrics.
    rental.last_sender = "owner";
    expect(compareQuickReplies(rental, enquiry, "priority", 1000, "all")).toBeGreaterThan(0);
  });
});
