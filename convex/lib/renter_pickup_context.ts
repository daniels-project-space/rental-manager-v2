import {resolvePickupHours} from "../../src/lib/pickup-hours";

type PickupWindow={start:string;end:string};
type PickupProfile={pickup_area?:string;pickup_address?:string;pickup_hours?:PickupWindow[]};

/** On-demand, account-scoped pickup facts. The exact point is absent unless
 * the current booking stage explicitly permits sharing it. */
export function renterPickupContext(input:{account_slug:string;profile:PickupProfile|null;global_hours?:PickupWindow[];
  stage:string;can_share_pickup_address:boolean}) {
  const area=input.profile?.pickup_area?.trim()||null;
  const address=input.can_share_pickup_address?input.profile?.pickup_address?.trim()||null:null;
  return {
    account_slug:input.account_slug,
    stage:input.stage,
    pickup_area:area,
    pickup_area_source:area?"owner_account_profile":null,
    pickup_hours:resolvePickupHours(input.profile?.pickup_hours,input.global_hours),
    can_share_pickup_address:input.can_share_pickup_address,
    pickup_address:address,
    pickup_address_source:address?"owner_account_profile":null,
  };
}
