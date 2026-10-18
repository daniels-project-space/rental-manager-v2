const {connect}=require('./browser.cjs'),assert=require('node:assert/strict'),fs=require('node:fs');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const proof=[];
 for(const width of [1536,390]){
  const c=await connect('about:blank');await c.cmd('Page.enable');await c.cmd('Emulation.setDeviceMetricsOverride',{width,height:1024,deviceScaleFactor:1,mobile:width<500});await c.cmd('Page.navigate',{url:process.env.RM_QA_ORIGIN});await pause(650);
  await c.evaluate(`(()=>{const f=window.__fixture;f.messages.splice(0);f.history={'fixture-0':Array.from({length:125},(_,i)=>({id:'history-'+i,role:i===100?'system':i%2?'renter':'owner',content:i===100?'Everything is booked and ready': 'History message '+i,timestamp:Date.now()-((125-i)*60000),images:i===110?[{url:'/gear0.png',thumbnail:'/gear0.png'}]:[]}))};f.liveTiles={'fixture-0':{...f.rows[0],order_step:'RETURNED',platform_booking_confirmed:true}};f.changed();document.querySelector('[data-thread-id="fixture-0"]').click()})()`);await pause(500);
  const check=await c.evaluate(`(()=>{const d=document.querySelector('[role="dialog"]');return{stage:d.querySelector('[aria-label^="Booking progress"]')?.getAttribute('aria-label'),event:!![...d.querySelectorAll('[role="note"]')].find(e=>e.textContent.includes('Everything is booked and ready')),attachment:!!d.querySelector('img[alt="Conversation attachment"]'),load:!![...d.querySelectorAll('button')].find(b=>b.textContent==='Load earlier messages')}})()`);
  assert.equal(check.stage,'Booking progress: Confirmed');assert(check.event&&check.attachment&&check.load);
  for(let i=0;i<3;i++){
   await c.evaluate(`(()=>{const b=[...document.querySelector('[role="dialog"]').querySelectorAll('button')].find(b=>b.textContent==='Load earlier messages');b?.scrollIntoView({block:'center'});b?.click()})()`);await pause(180);
  }
  const all=await c.evaluate(`(()=>{const d=document.querySelector('[role="dialog"]');return{oldest:d.textContent.includes('History message 0'),newest:d.textContent.includes('History message 124'),messages:d.querySelectorAll('[data-message-id]').length,load:[...d.querySelectorAll('button')].some(b=>b.textContent==='Load earlier messages'),scroll:[...d.querySelectorAll('div')].find(e=>e.className.includes('messages'))?.scrollTop}})()`);
  assert(all.oldest&&all.newest&&!all.load);assert.equal(all.messages,124);assert(all.scroll>0,'Loading older messages preserves reading position');
  await c.evaluate(`window.__fixture.messages.push({id:'sent-new',role:'owner',content:'Just-sent fixture response',timestamp:Date.now()+1000});window.__fixture.changed()`);await pause(100);
  assert(await c.evaluate(`document.querySelector('[role="dialog"]').textContent.includes('Just-sent fixture response')`));
  fs.writeFileSync(process.env.RM_QA_OUTPUT+'/history-'+width+'.png',Buffer.from((await c.cmd('Page.captureScreenshot')).data,'base64'));
  proof.push({width,...check,...all,liveTail:true});c.close();
 }
 fs.writeFileSync(process.env.RM_QA_OUTPUT+'/history-proof.json',JSON.stringify(proof,null,2));console.log(proof);
})().catch(e=>{console.error(e);process.exit(1)});
