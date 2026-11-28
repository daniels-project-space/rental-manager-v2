import {describe,it,expect} from "vitest";
import {renterPickupContext} from "./renter_pickup_context";

describe("on-demand pickup context",()=>{
  it("returns the account area and effective hours but withholds the exact point before confirmation",()=>{
    const context=renterPickupContext({account_slug:"dbcinema",stage:"INQUIRY",can_share_pickup_address:false,
      profile:{pickup_area:"Northumberland Street area",pickup_address:"10 Northumberland Street",pickup_hours:[]},
      global_hours:[{start:"10:00",end:"12:00"},{start:"19:00",end:"21:00"}]});
    expect(context).toMatchObject({pickup_area:"Northumberland Street area",pickup_address:null,
      can_share_pickup_address:false,pickup_hours:[{start:"10:00",end:"12:00"},{start:"19:00",end:"21:00"}]});
  });

  it("returns the exact point only when the shared booking stage permits it",()=>{
    const context=renterPickupContext({account_slug:"dbcinema",stage:"CONFIRMED_UPCOMING",can_share_pickup_address:true,
      profile:{pickup_area:"Northumberland Street area",pickup_address:"10 Northumberland Street"}});
    expect(context).toMatchObject({pickup_address:"10 Northumberland Street",pickup_address_source:"owner_account_profile"});
  });
});
