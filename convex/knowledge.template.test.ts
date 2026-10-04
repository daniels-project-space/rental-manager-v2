import { describe, expect, it } from 'vitest';
import { getTemplate } from './knowledge';

const template=(title:string,tags:string[],content='Exact template')=>({scope:'template',title,tags,content,updated_at:42});
function fetch(rows:ReturnType<typeof template>[],args:{name:string;accountSlug?:string;threadId?:string},account='leo') {
 const db={query:(table:string)=>{
  let filtered:Array<ReturnType<typeof template>|{thread_id:string;account_slug:string}>=table==='memories'?rows:[{thread_id:'native-thread',account_slug:account}];
  const query:any={withIndex:(_name:string,select:any)=>{const index:any={eq:(key:string,value:any)=>{filtered=filtered.filter((row:any)=>row[key]===value);return index;}};select(index);return query;},collect:async()=>filtered,first:async()=>filtered[0]??null};return query;
 }};
 return (getTemplate as any)._handler({db},args);
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
