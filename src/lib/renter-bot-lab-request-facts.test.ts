import {describe,it,expect} from "vitest";
import {renterBotLabRequestFacts} from "./renter-bot-lab-request-facts";

describe("isolated Lab's initial renter context",()=>{
  it("keeps only the requested rental, date, time and money facts",()=>{
    const facts=renterBotLabRequestFacts({start_date:"2026-12-11",end_date:"2026-12-11",pickup_time:"10:00",return_time:"19:00",stage:"INQUIRY",
      items:[{name:"BMPCC 6K Full Frame",qty:1,daily_price_gbp:50,listing_name:"SEO cage and batteries",listing_description:"5 batteries, cage",
        kit_contents:["5× NP-F570 batteries"],pickup_area:"Northumberland Street",pickup_availability:{status:"currently_on_rental"}}]},
      "dbcinema",50);
    expect(facts).toContain("BMPCC 6K Full Frame");
    expect(facts).toContain("2026-12-11");
    expect(facts).toContain("current_daily_price_gbp");
    expect(facts).toContain("current_total_gbp");
    expect(facts).toContain("10:00");
    expect(facts).toContain("19:00");
    expect(facts).toContain("INQUIRY");
    expect(facts).not.toMatch(/NP-F570|SEO cage|batteries|pickup_area|currently_on_rental|listing_description|Northumberland/);
    expect(facts).toContain("get_listing_context");
    expect(facts).toContain("get_pickup_context");
    expect(facts).toContain("call BOTH get_listing_context and get_pickup_context");
    expect(facts).toContain("current owner-verified reason");
  });
});
