/* Real React surface; synthetic inventory and DNS-blocked transport only. */
const {connect}=require('./browser.cjs'),assert=require('node:assert/strict'),fs=require('node:fs');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
 const proof=[];
 for(const width of [1505,390]){
  const c=await connect('about:blank');
  try {
   await c.cmd('Emulation.setDeviceMetricsOverride',{width,height:1045,deviceScaleFactor:1,mobile:width<500});
   await c.cmd('Page.navigate',{url:process.env.RM_QA_ORIGIN});await pause(700);
   await c.evaluate(`(()=>{const rows=window.__fixture.rows;const states=[['available',undefined,true],['conflict','Marketing-only listing · not stocked for hire',false],['available',undefined,true],['conflict','Requested kit unavailable',false]];states.forEach(([status,reason,available],i)=>{rows[i].can_accept=true;rows[i].can_deny=true;rows[i].availability={status,reason,stock_rules_version:7,window:{start_date:"2026-10-15",end_date:"2026-10-16",source:i===3?"today":i===2?"chat":"booking",note:i===2?"Dates requested in chat":i===3?"No rental dates supplied; today only":"Booked dates"},checked_at:Date.now(),items:rows[i].items.map(item=>({...item,requested:item.qty,available,reason,free:available?2:0,total_units:2}))};});window.__fixture.changed()})()`);
   await pause(200);
   await c.evaluate(`[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')?.startsWith('All (')).click()`);await pause(150);
   const actual=await c.evaluate(`[0,1,2,3].map(i=>document.querySelector('[data-thread-id="fixture-'+i+'"]').querySelector('[class*="availability"]').textContent)`);
   assert.deepEqual(actual,['Available','Unavailable','Available','Unavailable today']);
   const approvals=await c.evaluate(`[0,1,2,3].map(i=>[...document.querySelector('[data-thread-id="fixture-'+i+'"]').querySelectorAll('button')].some(b=>b.textContent.trim()==='Approve'))`);
   assert.deepEqual(approvals,[true,false,false,false],'Only proven available requests offer approval');
   assert(!await c.evaluate(`/Needs stock review|Not bookable|Dates needed/.test(document.body.textContent)`));
   await c.evaluate(`window.__fixture.rows[0].availability.window.source='today';window.__fixture.changed()`);await pause(120);
   assert.equal(await c.evaluate(`document.querySelector('[data-thread-id="fixture-0"]').querySelector('[class*="availability"]').textContent`),'Available today');
   assert(!await c.evaluate(`[...document.querySelector('[data-thread-id="fixture-0"]').querySelectorAll('button')].some(b=>b.textContent.trim()==='Approve')`),'today-only stock never enables rental approval');
   assert(await c.evaluate(`document.documentElement.scrollWidth<=innerWidth+1`));
   fs.writeFileSync(`${process.env.RM_QA_OUTPUT}/availability-${width}.png`,Buffer.from((await c.cmd('Page.captureScreenshot',{captureBeyondViewport:false})).data,'base64'));
   proof.push({width,labels:actual,noPageOverflow:true,externalDNSBlocked:true});
  } finally {await c.closePage();}
 }
 fs.writeFileSync(`${process.env.RM_QA_OUTPUT}/availability-proof.json`,JSON.stringify({proof,realMessages:0,realRentalChanges:0},null,2));
})().catch(error=>{console.error(error);process.exitCode=1});
