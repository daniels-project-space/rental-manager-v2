import { describe, it, expect } from "vitest";
import { acceptsRemoval } from "./renter_removal_acceptance";
const booked=[{product_id:1,name:"Sony FX3",qty:1,line_total_gbp:80},
  {product_id:2,name:"Blazar Remus 100mm",qty:2,line_total_gbp:100},
  {product_id:3,name:"PL to L mount adapter",qty:1,line_total_gbp:20}];
describe("exact renter removal acceptance",()=>{
  for(const text of ["Please remove one Blazar Remus 100mm.","Could you drop one Blazar Remus 100mm from my booking?",
    "Go ahead and remove one Blazar Remus 100mm for £50 less.","Please remove one Blazar Remus 100mm for a £150 total.",
    "I would like you to remove one Blazar Remus 100mm."])
    it(`accepts ${text}`,()=>expect(acceptsRemoval(text,booked,{product_id:2,qty:1})).toBe(true));
  for(const text of ["How heavy is the Sony FX3?","Please add a Blazar Remus 100mm.","Please remove Sony FX3.",
    "Please remove two Blazar Remus 100mm.","Please don't remove Blazar Remus 100mm.","If I remove the Blazar Remus 100mm, what happens?",
    "Please remove Blazar Remus 100mm after I confirm.","My friend said please remove Blazar Remus 100mm.",
    'He suggested "Please remove Blazar Remus 100mm".',"Please remove it.","Yes, please.","Please remove a lens.",
    "Please remove Blazar Remus 100mm or Sony FX3.","Please remove Blazar Remus 100mm and PL to L mount adapter.",
    "Please remove Blazar Remus 100mm for £49.99 less."])
    it(`does not license another selection: ${text}`,()=>expect(acceptsRemoval(text,booked,{product_id:2,qty:1})).toBe(false));
  it("matches the current booking period",()=>expect(acceptsRemoval("Please remove Blazar Remus 100mm from 22-23 October.",booked,{product_id:2,qty:1},{start_date:"2026-10-20",end_date:"2026-10-21"})).toBe(false));
  it("resolves all units from the actual booked quantity",()=>expect(acceptsRemoval("Please remove all Blazar Remus 100mm.",booked,{product_id:2,qty:2})).toBe(true));
  it("resolves both as exactly two units",()=>expect(acceptsRemoval("Please remove both Blazar Remus 100mm.",booked,{product_id:2,qty:2})).toBe(true));
  it("supports a directly requested exact quantity",()=>expect(acceptsRemoval("Please remove two Blazar Remus 100mm.",booked,{product_id:2,qty:2})).toBe(true));
  it("refuses a kit component selected as a whole commercial kit",()=>{
    expect(acceptsRemoval("Please remove the Canon 24-105mm lens.",[{product_id:4,name:"Blackmagic 6K Full Frame + Canon 24-105mm",qty:1,line_total_gbp:124}],{product_id:4,qty:1})).toBe(false);
  });
  it("requires real known Native prices",()=>expect(acceptsRemoval("Remove Blazar Remus 100mm.",[{...booked[1],line_total_gbp:NaN}],{product_id:2,qty:1})).toBe(false));
});

it("distinguishes the remaining total from the reduction",()=>{
 for(const text of ["Please remove one Blazar Remus 100mm for £50 less, bringing the total to £150.","Please remove one Blazar Remus 100mm. The current total is £200 and the new total is £150."])
  expect(acceptsRemoval(text,booked,{product_id:2,qty:1})).toBe(true);
 for(const text of ["Please remove one Blazar Remus 100mm for £50 total.","Please remove one Blazar Remus 100mm for £150 less.","Please remove one Blazar Remus 100mm for £50 extra.","Please remove one Blazar Remus 100mm for £50/day.","Please remove one Blazar Remus 100mm for a £50 refund.","Please remove one Blazar Remus 100mm for £150.001 total."])
  expect(acceptsRemoval(text,booked,{product_id:2,qty:1})).toBe(false);
});

it("does not ignore a different currency or an incorrect GBP-code price",()=>{
 expect(acceptsRemoval("Please remove one Blazar Remus 100mm for GBP 50 less.",booked,{product_id:2,qty:1})).toBe(true);
 for(const amount of ["GBP 49.99","$50","50 USD","€50"])expect(acceptsRemoval(`Please remove one Blazar Remus 100mm for ${amount} less.`,booked,{product_id:2,qty:1})).toBe(false);
});
