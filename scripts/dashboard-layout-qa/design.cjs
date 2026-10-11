const {connect}=require('../quick-reply-qa/browser.cjs');
const fs=require('node:fs'),assert=require('node:assert/strict');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const receipts=[];
 for(const width of [1440,390]) {
  const c=await connect('about:blank');
  c.on(m=>{if(m.method==='Runtime.exceptionThrown') console.error(JSON.stringify(m.params));});await c.cmd('Runtime.enable');
  await c.cmd('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:width===390});
  await c.cmd('Page.navigate',{url:process.env.RM_QA_ORIGIN}); await pause(1600);
  const ev=x=>c.evaluate(x);
  assert.deepEqual(await ev('window.__layout.DEFAULT_PANEL_ORDER.slice(0,5)'),['stats-grid','lifetime','reply-inbox','live-calendar','return-hub']);
  assert.ok(await ev('window.__layout.DEFAULT_HIDDEN_PANELS.includes("calendar-strip") && window.__layout.stats.includes("conversation_funnel")'));
  assert.equal(await ev('document.querySelector("section[aria-label]").textContent.includes("DB Cinema Web")'),false);
  assert.equal(await ev('document.body.style.overflow'), '');
  assert.ok(await ev('document.querySelector("section[aria-label]").parentElement.style.gridRowEnd.startsWith("span ")'));
  await ev('document.querySelector("select").value="7"');

  assert.equal(await ev('document.querySelector(".gantt-embedded [aria-label=Close]")'),null);
  await ev('[...document.querySelectorAll(".gantt-embedded button")].find(b=>b.textContent.includes("Prev Week")).click()');await pause(150);
  await ev('[...document.querySelectorAll(".gantt-embedded button")].find(b=>b.textContent==="Today").click()');await pause(150);
  const initial=await ev('document.querySelector(".gantt-embedded h2").nextElementSibling.textContent');
  await ev('[...document.querySelectorAll(".gantt-embedded button")].find(b=>b.textContent.includes("Next Week")).click()'); await pause(200);
  assert.notEqual(await ev('document.querySelector(".gantt-embedded h2").nextElementSibling.textContent'),initial);
  await ev('[...document.querySelectorAll(".gantt-embedded button")].find(b=>b.textContent==="Today").click()'); await pause(200);
  assert.equal(await ev('document.querySelector(".gantt-embedded h2").nextElementSibling.textContent'),initial);
  await ev('[...document.querySelectorAll(".gantt-embedded button")].find(b=>b.textContent.trim()==="Leo").click()');await pause(100);
  assert.equal(await ev('[...document.querySelectorAll(".gantt-embedded button")].find(b=>b.textContent.trim()==="Leo").getAttribute("aria-pressed")'),'true');
  const shot=async name=>fs.writeFileSync(`${process.env.RM_QA_OUTPUT}/${name}-${width}.png`,Buffer.from((await c.cmd('Page.captureScreenshot',{captureBeyondViewport:false})).data,'base64'));
  await shot('dashboard-top');
  const bar=await ev('(()=>{const e=document.querySelector(".recharts-bar-rectangle path"); if(!e) return null;const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()');
  assert.ok(bar,'revenue bars render');
  await c.cmd('Input.dispatchMouseEvent',{type:'mouseMoved',...bar});await pause(300);
  assert.equal(await ev('document.querySelector("[data-revenue-bar-total]")?.textContent'),'Bar total£1,800');
  await shot('revenue-hover');
  await ev('document.querySelector(".gantt-embedded").scrollIntoView({block:"start"})');await pause(150);await shot('calendar');
  const geometry=await ev('(()=>{const c=document.querySelector(".gantt-embedded").getBoundingClientRect(); const r=document.querySelector("section[aria-label]").getBoundingClientRect(); return {calendarWidth:c.width,responseHeight:r.height,pageWidth:document.documentElement.scrollWidth,viewport:innerWidth}})()');
  assert.ok(geometry.pageWidth<=width+1,JSON.stringify(geometry));assert.ok(geometry.responseHeight<230,JSON.stringify(geometry));
  receipts.push({width,...geometry,checks:10});await c.close();
 }
 fs.writeFileSync(`${process.env.RM_QA_OUTPUT}/receipt.json`,JSON.stringify({receipts,realSends:0,realRentalChanges:0},null,2));
})().catch(e=>{console.error(e);process.exit(1)});
