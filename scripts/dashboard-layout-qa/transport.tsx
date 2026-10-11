// @ts-nocheck
// Actual widgets, isolated read fixtures; every mutation/action fails closed.
import { getFunctionName } from "convex/server";
import { useQuery as quickQuery } from "../quick-reply-qa/transport";
const funnel = { inquiries: 120, requests: 60, booked: 30, booked_net_gbp: 4200, request_rate:.5, book_rate_of_requests:.5, book_rate_of_inquiries:.25, reply:{eligible:90,replied:85,rate:85/90,awaiting_reply:5,too_new:30,p50_hours:1,p90_hours:3}, outcomes:[], top_leak:null };
export function useQuery(ref,args) {
 const name=getFunctionName(ref);
 if(args==='skip') return undefined;
 if(name==='channel_response_rates:get') return {generatedAt:Date.now(),channels:[{slug:'dbcinema',rate:.99},{slug:'leo',rate:.95},{slug:'diogo',rate:.89},{slug:'dbcinema_web',rate:null}]};
 if(name==='reservations:getConversionFunnel') return funnel;
 if(name==='revenue:getLifetimeByMonth') return {currentMonth:'2026-10',months:['2026-07','2026-08','2026-09','2026-10'].map(month=>({month,dbcinemaOrganic:1000,leoOrganic:500,diogoOrganic:250,damageClaims:50})),forecast:[]};
 if(name==='dashboard:getStatsDrawerData') return {monthly:{target_gbp:2200}};
 if(name==='calendar:getGanttWeek') return {items:[{item_id:'qa',item_name:'Sony FX6',image_url:null,account_slug:'dbcinema',account_color:'blue',blocks:[{reservation_id:'qa-res',start_date:args.weekStartIso,end_date:args.weekStartIso,return_date:args.weekStartIso,renter_name:'Fixture only',order_step:'VERIFIED',account_slug:'dbcinema'}]}]};
 if(name==='calendar:searchCalendarInventory') return {items:[],reservations:[]};
 if(name.includes('return')||name.includes('Return')) return [];
 return quickQuery(ref,args);
}
const blockedMutation=async()=>{throw Error('Dashboard QA: real writes prohibited')};
export function useMutation(){return blockedMutation;}
const blockedAction=async()=>{throw Error('Dashboard QA: actions prohibited')};
export function useAction(){return blockedAction;}
export const usePaginatedQuery=()=>({results:[],status:'Exhausted',loadMore:()=>{}});
export const useConvex=()=>({query:async()=>{throw Error('QA direct client disabled')}});
export const useConvexAuth=()=>({isAuthenticated:true,isLoading:false});
