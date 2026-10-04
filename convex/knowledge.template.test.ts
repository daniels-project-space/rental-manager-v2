import { describe, expect, it } from 'vitest';
import { getTemplate, search } from './knowledge';

const template=(title:string,tags:string[],content='Exact template')=>({scope:'template',title,tags,content,updated_at:42});
function fetch(rows:ReturnType<typeof template>[],args:Record<string,unknown>,account='leo',fn:any=getTemplate,rules:Array<Record<string,unknown>>=[],accounts:Array<Record<string,unknown>>=[]) {
 const db={query:(table:string)=>{
  let filtered:Array<Record<string,unknown>>=table==='memories'?rows:table==='conversations'?[{thread_id:'native-thread',account_slug:account}]:table==='rules'?rules:table==='accounts'?accounts:[];
  const query:any={withIndex:(_name:string,select:any)=>{const index:any={eq:(key:string,value:any)=>{filtered=filtered.filter((row:any)=>row[key]===value);return index;}};select(index);return query;},collect:async()=>filtered,first:async()=>filtered[0]??null};return query;
 }};
 return fn._handler({db},args);
}
describe('Native template identity',()=>{
 const welcome=template('Template: DB Cinema Welcome Text',['template','welcome','dbcinema']);
 const price=template('Template: DB Cinema Price Match',['template','price-match','dbcinema']);
 it('does not substitute a different template for a missing name',async()=>{
  expect(await fetch([welcome,price],{name:'DB Cinema nonexistent-template-probe',accountSlug:'dbcinema'})).toMatchObject({found:false,content:null});
  expect(await fetch([template('Template: Leo Adams Welcome Text',['leo'])],{name:'Leo Price Match',accountSlug:'leo'})).toMatchObject({found:false,content:null});
 });
 it('accepts an exact discovered title with optional Template prefix, case and whitespace normalization',async()=>{
  for(const name of ['Template: DB Cinema Price Match',' db cinema   price MATCH '])expect(await fetch([welcome,price],{name,accountSlug:'dbcinema'})).toMatchObject({found:true,name:price.title,content:price.content,lastModified:42});
 });
 it('does not select by row order when duplicate exact identities exist',async()=>{
  expect(await fetch([price,{...price,content:'Conflicting version'}],{name:'DB Cinema Price Match',accountSlug:'dbcinema'})).toMatchObject({found:false,content:null});
 });
 it('filters every canonical account by exact tags, including diogo and shared templates',async()=>{
  const diogo=template('Template: Reminder',['diogo']);const global=template('Template: Global Reminder',['template']);
  expect(await fetch([diogo],{name:'Reminder',accountSlug:'leo'})).toMatchObject({found:false});
  expect(await fetch([diogo],{name:'Reminder',accountSlug:'diogo'})).toMatchObject({found:true});
  expect(await fetch([global],{name:'Global Reminder',accountSlug:'leo'})).toMatchObject({found:true});
 });
 it('uses Native thread ownership even if the caller supplies a different account',async()=>{
  expect(await fetch([price],{name:'DB Cinema Price Match',threadId:'native-thread',accountSlug:'dbcinema'})).toMatchObject({found:false,content:null});
  expect(await fetch([price],{name:'DB Cinema Price Match',threadId:'native-thread'})).toMatchObject({found:false,content:null});
  expect(await fetch([price],{name:'DB Cinema Price Match',threadId:'native-thread'},'dbcinema')).toMatchObject({found:true});
  expect(await fetch([price],{name:'DB Cinema Price Match',threadId:'missing',accountSlug:'dbcinema'})).toMatchObject({found:false});
 });
});


describe('policy search uses the same Native account as exact templates',()=>{
 const rows=[template('Template: DB Cinema Travel Discount',['dbcinema','travel-discount'],'Travel discount ten percent'),template('Shared Discount Review',['policy'],'Ask about the budget and suitable options')];
 it('does not deliver another account template through fuzzy search',async()=>{
  const scoped=await fetch(rows,{query:'travel discount',threadId:'native-thread',limit:5},'leo',search);
  expect(scoped.some((hit:any)=>hit.title==='Template: DB Cinema Travel Discount')).toBe(false);
  const own=await fetch(rows,{query:'travel discount',threadId:'native-thread',limit:5},'dbcinema',search);
  expect(own.some((hit:any)=>hit.title==='Template: DB Cinema Travel Discount')).toBe(true);
 });
 it('retains shared policy and rejects a missing or mismatched Native chat',async()=>{
  expect(await fetch(rows,{query:'budget options',threadId:'native-thread'},'leo',search)).toEqual(expect.arrayContaining([expect.objectContaining({title:'Shared Discount Review'})]));
  expect(await fetch(rows,{query:'travel discount',threadId:'native-thread',accountSlug:'dbcinema'},'leo',search)).toEqual([]);
  expect(await fetch(rows,{query:'travel discount',threadId:'missing'},'leo',search)).toEqual([]);
 });
});


it('keeps shared rules while filtering account-owned policy by its Native account ID',async()=>{
 const rules=[{_id:'shared',enabled:true,rule_kind:'Shared discount review',rule_body:'Discount request review',category:'pricing'},
 {_id:'db-rule',enabled:true,account_id:'db-account',rule_kind:'DB discount',rule_body:'Discount special terms',category:'pricing'}];
 const accounts=[{_id:'db-account',slug:'dbcinema'},{_id:'leo-account',slug:'leo'}];
 const leo=await fetch([],{query:'discount',threadId:'native-thread'},'leo',search,rules,accounts);
 expect(leo.map((hit:any)=>hit.title)).toEqual(['Shared discount review']);
 const db=await fetch([],{query:'discount',threadId:'native-thread'},'dbcinema',search,rules,accounts);
 expect(db.map((hit:any)=>hit.title)).toEqual(expect.arrayContaining(['Shared discount review','DB discount']));
});
