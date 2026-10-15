import {describe,it,expect,vi} from 'vitest';
vi.mock('./widgets',()=>({refreshHandoffsWidget:vi.fn()}));
vi.mock('../auth',()=>({authComponent:{safeGetAuthUser:vi.fn()}}));
import {getFunctionName} from 'convex/server';
import {refreshAll} from './reply_queue';
import {replyPartitionKey,mergeReplyPartitions} from '../lib/reply_queue_partitions';
const row=(thread_id:string,last_renter_msg_at:number,is_request=false)=>({thread_id,last_renter_msg_at,is_request,last_sender:'renter',last_activity_at:last_renter_msg_at,availability:{status:'available'}});
describe('bounded account cohorts with global shared stock',()=>{
 it('retains configured, account-ID-only and unassigned legacy conversations',()=>{
  const accounts=[{_id:'one',slug:'dbcinema'},{_id:'two',slug:'leo'}];
  expect(replyPartitionKey({account_slug:'leo'},accounts)).toBe('leo');
  expect(replyPartitionKey({account_id:'one'},accounts)).toBe('dbcinema');
  expect(replyPartitionKey({account_slug:'retired'},accounts)).toBeNull();expect(replyPartitionKey({},accounts)).toBeNull();
 });
 it('merges full coverage before applying the global limit and preserves oldest-waiting priority',()=>{
  const a=row('a',20),b=row('b',10),c=row('c',30,true),owner={...row('owner',1),last_sender:'owner',last_msg_at:99};
  expect(mergeReplyPartitions([[a,owner],[b,c]],10).map(r=>r.thread_id)).toEqual(['c','b','a','owner']);
  expect(mergeReplyPartitions([[a,owner],[b,c]],2).map(r=>r.thread_id)).toEqual(['c','b']);
 });
 it('deduplicates legacy cross-cohort lookups using the fresher complete row',()=>{
  const before=row('same',10),after={...row('same',20),availability:{status:'conflict'}};
  expect(mergeReplyPartitions([[before],[after]],10)).toEqual([after]);
 });
 it('publishes once only after every account is complete, with shared pending-stock policy retained',async()=>{
  const calls:any[]=[],writes:any[]=[];const ctx:any={runQuery:async(ref:any,args:any)=>{const name=getFunctionName(ref);if(name.endsWith(':currentIncludePending'))return true;if(name.endsWith(':partitionAccounts'))return ['dbcinema','leo',null];if(name.endsWith(':__service_getReplyQueue')){calls.push(args);return args._partitionSlug==='leo'?[row('leo',10)]:args._partitionSlug==='dbcinema'?[row('db',20)]:[];}throw Error(name);},runMutation:async(ref:any,args:any)=>{writes.push({name:getFunctionName(ref),args});}};
  expect(await refreshAll(ctx,true)).toMatchObject({ok:true,written:1});expect(calls.map(c=>c._partitionSlug)).toEqual(['dbcinema','leo',null]);expect(calls.every(c=>c.includePending===true&&c._bypassMv===true&&!c.accountSlug)).toBe(true);expect(writes).toHaveLength(1);expect(writes[0].args.tiles.map((r:any)=>r.thread_id)).toEqual(['leo','db']);
 });
 it('never publishes a partial account result after any cohort fails',async()=>{
  const write=vi.fn();const ctx:any={runQuery:async(ref:any,args:any)=>{const name=getFunctionName(ref);if(name.endsWith(':currentIncludePending'))return true;if(name.endsWith(':partitionAccounts'))return ['dbcinema','leo'];if(args._partitionSlug==='leo')throw Error('Cohort failed');return [row('db',10)];},runMutation:write};
  await expect(refreshAll(ctx,true)).rejects.toThrow('Cohort failed');expect(write).not.toHaveBeenCalled();
 });
});
