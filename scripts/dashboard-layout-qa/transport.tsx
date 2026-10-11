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
 if(name==='calendar:getGanttWeek') {
   const day=n=>new Date(Date.parse(args.weekStartIso+'T12:00Z')+n*86400000).toISOString().slice(0,10);
   const block=(id,n,extra={})=>({reservation_id:id,start_date:day(n),end_date:day(n),return_date:day(n),renter_name:'Fixture only',order_step:'RETURNED',account_slug:'dbcinema',...extra});
   return {items:[{item_id:'qa',item_name:'Sony FX6',image_url:null,account_slug:'dbcinema',account_color:'blue',blocks:[
     block('qa-res',0,{pickup_time:'09:15',return_time:'10:00',pickup_time_status:'reported',return_time_status:'reported'}),
     block('qa-long',1,{renter_name:'Long fixture name to check handover information never clips',pickup_time:'08:00',return_time:'22:00',pickup_time_status:'confirmed',return_time_status:'confirmed'}),
     block('qa-wide',0,{end_date:day(6),return_date:day(6),renter_name:'Yevhenii Petrusenko',pickup_time:'09:15',return_time:'17:30',pickup_time_status:'reported',return_time_status:'reported'}),
     block('qa-missing',2),
     block('qa-web',3,{account_slug:'dbcinema_web',pickup_time:'13:00',return_time:'14:45',pickup_time_status:'confirmed',return_time_status:'confirmed'}),
     block('qa-extension',4,{start_date:day(3),return_time:'17:30',return_time_status:'reported'}),
     block('qa-extension',5,{start_date:day(4)})
   ]}]};
 }
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
