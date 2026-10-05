import {v,type Infer} from "convex/values";

/** Context only: never booking consent, stock, pricing or verification proof. */
export const rentalRequestValidator=v.union(v.object({kind:v.literal("primary")}),v.object({kind:v.literal("inquiry"),origin_message_id:v.string()}));
export type RentalRequest=Infer<typeof rentalRequestValidator>;
export const PRIMARY_RENTAL_REQUEST:RentalRequest={kind:"primary"};
export function sameRentalRequest(a:RentalRequest,b:RentalRequest){return a.kind===b.kind&&(a.kind==="primary"||b.kind==="inquiry"&&a.origin_message_id===b.origin_message_id);}

