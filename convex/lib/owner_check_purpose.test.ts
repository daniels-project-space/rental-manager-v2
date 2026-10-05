import {describe,it,expect} from 'vitest';
import {nativeOwnerChecks,ownerCheckBlocksRequest} from './owner_checks';
import type {StockQuoteEvidence} from './renter_draft_evidence';
const check={kind:'kit_recommendation' as const,candidate_product_ids:[1172384],start_date:'2026-10-20',end_date:'2026-10-21',quantity:1};
const receipt={tool:'find_owned_alternatives',call_id:'native-search',result:{owner_check:check,alternatives:[{product_id:1097510,name:'Sony FX3'},{product_id:1172384,name:'Sony A7 V',spec_verification:{model:'ILCE-7M5'}}]}};
const quote:StockQuoteEvidence={quote_key:'native-selected',start_date:check.start_date,end_date:check.end_date,items:[],listing_quote:{total_gbp:98,lines:[{product_id:1097510,name:'Sony FX3',quantity:1,total_gbp:98}]}};
const collect=(quotes=[quote],discussion='Canon R5 is unavailable; Sony FX3 is the option.')=>nativeOwnerChecks([receipt],{quotes,discussion})[0];
describe('Native owner review purpose',()=>{
 it('retains an unchosen inventory problem without blocking a qualified alternative',()=>{
  expect(collect()).toMatchObject({...check,purpose:'inventory',source_call_id:'native-search'});
  expect(ownerCheckBlocksRequest(collect())).toBe(false);
  expect(ownerCheckBlocksRequest(collect([quote],'Does the A7 VI include a card?'))).toBe(false);
  expect(receipt.result.owner_check).not.toHaveProperty('purpose');
 });
 it('keeps the check required without a matching dated and counted alternative',()=>{
  for(const quotes of [[],[{...quote,end_date:'2026-10-22'}],[{...quote,listing_quote:{...quote.listing_quote!,lines:[{...quote.listing_quote!.lines[0],quantity:2}]}}],[{...quote,listing_quote:{...quote.listing_quote!,lines:[{...quote.listing_quote!.lines[0],product_id:999}]}}]])
   expect(ownerCheckBlocksRequest(collect(quotes))).toBe(true);
 });
 it('keeps explicitly discussed or selected kits required even when another option is quoted',()=>{
  for(const discussion of ['What storage does Sony A7 V include?','Please check the A7V too.','Is ILCE-7M5 media included?'])expect(ownerCheckBlocksRequest(collect([quote],discussion))).toBe(true);
  const mixed={...quote,listing_quote:{...quote.listing_quote!,lines:[...quote.listing_quote!.lines,{product_id:1172384,name:'Sony A7 V',quantity:1,total_gbp:80}]}};
  expect(ownerCheckBlocksRequest(collect([mixed]))).toBe(true);
 });
 it('does not let purpose metadata dismiss other required checks or old records',()=>{
  expect(ownerCheckBlocksRequest({...check,source_call_id:'native'})).toBe(true);
  expect(ownerCheckBlocksRequest({kind:'listing_mapping',source_call_id:'native',product_id:10,start_date:null,end_date:null,quantity:1,purpose:'inventory'})).toBe(true);
 });
});
