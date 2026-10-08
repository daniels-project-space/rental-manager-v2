import {afterEach,describe,expect,it,vi} from 'vitest';
vi.mock('./auth',()=>({authComponent:{safeGetAuthUser:vi.fn()}}));
vi.mock('../src/lib/hygglo-auth',()=>({HYGGLO_API_BASE:'https://api.hygglo.com/api',getAccountCredentials:vi.fn(async()=>({})),getHyggloAccessToken:vi.fn(async()=>'TEST_TOKEN'),hyggloAuthHeaders:vi.fn(()=>({}))}));
import {rescan,refreshDescriptions} from './online_listings_actions';
import {setDescription} from './online_listings';
import {retainedListingDescription} from './lib/listing_description';
import descriptions from './fixtures/sony-gm-listing-descriptions.json';
afterEach(()=>vi.unstubAllGlobals());
describe('actual authoritative listing description callers',()=>{
 it('rescans the current provider API and stores the entire source contents',async()=>{
  const source=descriptions[0].description;
  const fetch=vi.fn(async(_url:string)=>new Response(JSON.stringify([{id:973616,name:'Sony GM lens',description:source,isPublished:true}]),{status:200}));vi.stubGlobal('fetch',fetch);
  let saved:any;const ctx:any={runMutation:vi.fn(async(_:any,args:any)=>{saved=args;return {stored:1}}),runQuery:async()=>[]};
  expect(await (rescan as any)._handler(ctx,{account_slug:'dbcinema'})).toEqual({ok:true,stored:1});
  expect(fetch.mock.calls[0][0]).toBe('https://api.hygglo.com/api/v4/my/products');expect(saved.listings[0].description).toBe(source);expect(source.length).toBeGreaterThan(2500);
 });
 it('does not replace cached listings after a rejected provider read',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>new Response('not found',{status:404})));const mutation=vi.fn();
  expect(await (rescan as any)._handler({runMutation:mutation},{account_slug:'dbcinema'})).toMatchObject({ok:false});expect(mutation).not.toHaveBeenCalled();
 });
 it('retains provider newline structure and long tails through lazy backfill',async()=>{
  const source=descriptions[0].description;let saved:any;const row:any={_id:'listing'};const audit=vi.fn();
  const query:any={withIndex:()=>query,unique:async()=>row};const ctx:any={db:{query:()=>query,patch:async(_:any,patch:any)=>{saved=patch;Object.assign(row,patch)},insert:audit}};
  await (setDescription as any)._handler(ctx,{account_slug:'dbcinema',product_id:973616,description:source});
  expect(saved.description).toBe(source);expect(saved.description).toContain('\n1x Uv Filter\n');
  await (setDescription as any)._handler(ctx,{account_slug:'dbcinema',product_id:973616,description:source});expect(audit).toHaveBeenCalledTimes(1);expect(audit.mock.calls[0][0]).toBe('audit_log');
 });
 it('fetches verified current detail identities and never stores failed or mismatched reads',async()=>{
  const source=descriptions[0];const fetch=vi.fn(async(url:string)=>url.endsWith('/973616')?new Response(JSON.stringify({id:973616,description:source.description})):url.endsWith('/971143')?new Response(JSON.stringify({id:1,description:'wrong listing'})):new Response('',{status:404}));vi.stubGlobal('fetch',fetch);const write=vi.fn(async(_ref:any,_args:any)=>({ok:true}));
  const result=await (refreshDescriptions as any)._handler({runMutation:write},{account_slug:'dbcinema',product_ids:[973616,971143,1103079]});
  expect(result).toMatchObject({refreshed:1,failed:2});expect(write).toHaveBeenCalledTimes(1);expect(write.mock.calls[0][1]).toMatchObject({product_id:973616,description:source.description});expect(fetch.mock.calls[0][0]).toContain('/v4/my/products/');
 });
 it('bounds each repair call and rejects duplicate product reads before provider access',async()=>{
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
  await expect((refreshDescriptions as any)._handler({}, {account_slug:'dbcinema',product_ids:Array.from({length:9},(_,n)=>n+1)})).rejects.toThrow('up to eight');
  await expect((refreshDescriptions as any)._handler({}, {account_slug:'dbcinema',product_ids:[1,1]})).rejects.toThrow('up to eight');expect(fetch).not.toHaveBeenCalled();
 });
 it('rejects unsupported source lengths rather than silently losing kit contents',()=>{
  expect(retainedListingDescription('x'.repeat(20_000))).toHaveLength(20_000);expect(()=>retainedListingDescription('x'.repeat(20_001))).toThrow('supported length');
 });
});
