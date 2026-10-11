const {connect}=require('../quick-reply-qa/browser.cjs');
const fs=require('node:fs'),assert=require('node:assert/strict');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const receipts=[];
 for(const width of [1440,1024,768,390]) {
  const c=await connect('about:blank');
  c.on(m=>{if(m.method==='Runtime.exceptionThrown') console.error(JSON.stringify(m.params));});await c.cmd('Runtime.enable');
  await c.cmd('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:width===390});
  await c.cmd('Page.navigate',{url:process.env.RM_QA_ORIGIN}); await pause(1600);
  const ev=x=>c.evaluate(x);
  assert.deepEqual(await ev('window.__layout.DEFAULT_PANEL_ORDER.slice(0,5)'),['stats-grid','lifetime','reply-inbox','live-calendar','return-hub']);
  assert.ok(await ev('window.__layout.DEFAULT_HIDDEN_PANELS.includes("calendar-strip") && window.__layout.stats.includes("conversation_funnel")'));
  assert.equal(await ev('document.querySelector("section[aria-label]").textContent.includes("DB Cinema Web")'),false);
  assert.equal(await ev('document.body.style.overflow'), '');
  const assertNoOverlap = async () => {
    const bounds = await ev('[...document.querySelector("main > div.grid").children].map(e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom}})');
    for (let i=0;i<bounds.length;i++) for(let j=i+1;j<bounds.length;j++) {
      const a=bounds[i],b=bounds[j];
      assert.ok(!(Math.min(a.right,b.right)-Math.max(a.x,b.x)>1 && Math.min(a.bottom,b.bottom)-Math.max(a.y,b.y)>1), `Widgets ${i}/${j} overlap at ${width}px`);
    }
    assert.ok(await ev('document.querySelector("main > div.grid").getBoundingClientRect().bottom >= Math.max(...[...document.querySelector("main > div.grid").children].map(e=>e.getBoundingClientRect().bottom))'));
  };
  await assertNoOverlap();
  const verifyPacking = async () => {
    const g = await ev(`(()=>{const slots=[...document.querySelectorAll('[data-packing-fixture]')];return slots.map(e=>{const r=e.querySelector('[data-packing-content]').getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,span:e.style.gridRow}})})()`);
    assert.ok(g[2].y < g[0].bottom, 'short cards must backfill beside the tall card');
    assert.ok(g[2].y-g[1].bottom >= 10 && g[2].y-g[1].bottom <= 14, 'packing must leave only the configured gap');
    for(let i=0;i<g.length;i++) for(let j=i+1;j<g.length;j++) assert.ok(!(Math.min(g[i].right,g[j].right)-Math.max(g[i].x,g[j].x)>1 && Math.min(g[i].bottom,g[j].bottom)-Math.max(g[i].y,g[j].y)>1),'packing content overlaps');
    assert.ok(g.every(r=>r.span.startsWith('auto / span')), 'both legacy row lines are reset');
  };
  await verifyPacking();
  await ev(`document.querySelector('[data-packing-fixture="1"] [data-packing-content]').style.height='140px'`); await pause(150); await verifyPacking();
  await ev(`document.querySelector('[data-packing-fixture="1"] [data-packing-content]').style.height='90px'`); await pause(150); await verifyPacking();
  for(const resizedWidth of [390,1440,width]) {
    await c.cmd('Emulation.setDeviceMetricsOverride',{width:resizedWidth,height:1000,deviceScaleFactor:1,mobile:resizedWidth===390}); await pause(150); await verifyPacking(); await assertNoOverlap();
  }
  for(const [label,count] of [['Add packing card',7],['Hide packing card',5],['Reset packing cards',6]]) {
    await ev(`[...document.querySelectorAll('[data-packing-tests] button')].find(b=>b.textContent===${JSON.stringify(label)}).click()`); await pause(150);
    assert.equal(await ev('document.querySelectorAll("[data-packing-fixture]").length'),count); await verifyPacking();
  }
  const pill = await ev('(()=>{const r=document.querySelector("[data-utility-bar] button").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()');
  await c.cmd('Input.dispatchMouseEvent',{type:'mouseMoved',...pill});await pause(100);
  assert.equal(await ev('document.querySelector("[data-utility-bar] button").getAttribute("aria-expanded")'),'true');
  await c.cmd('Input.dispatchMouseEvent',{type:'mouseMoved',x:0,y:900});await pause(100);
  assert.equal(await ev('document.querySelector("[data-utility-bar] button").getAttribute("aria-expanded")'),'false');
  for (const label of ['Vacation Mode','To-Do','Insurance Claims']) {
    await ev(`[...document.querySelectorAll('[data-utility-bar] button')].find(b=>b.textContent.startsWith(${JSON.stringify(label)})).click()`);await pause(80);
    assert.equal(await ev(`[...document.querySelectorAll('[data-utility-bar] button')].find(b=>b.textContent.startsWith(${JSON.stringify(label)})).getAttribute('aria-expanded')`),'true');
    await assertNoOverlap();
    await ev(`[...document.querySelectorAll('[data-utility-bar] button')].find(b=>b.getAttribute('aria-label')===${JSON.stringify('Close '+label)}).click()`);await pause(80);
  }
  await ev('document.querySelector("details summary").click()');await pause(100);await assertNoOverlap();
  await ev('document.querySelector("details summary").click()');await pause(100);await assertNoOverlap();

  assert.equal(await ev('document.querySelector("[data-auto-packing-grid]").dataset.packing'),"masonry");
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
  // Restore All after proving account filtering, then inspect actual handover UI.
  await ev('[...document.querySelectorAll(".gantt-embedded button")].find(b=>b.textContent.trim()==="All").click()');await pause(100);
  const calendarProof=await ev(`(()=>{const root=document.querySelector('.gantt-embedded');const moments=[...root.querySelectorAll('[data-calendar-moment]')].filter(e=>e.getBoundingClientRect().width>0);return {text:root.textContent,moments:moments.map(e=>({text:e.textContent,width:e.clientWidth,scrollWidth:e.scrollWidth,height:e.clientHeight,scrollHeight:e.scrollHeight})),agenda:getComputedStyle(root.querySelector('[data-calendar-agenda]')).display}})()`);
  assert.ok(calendarProof.text.includes('Reported · not confirmed'));
  assert.ok(calendarProof.text.includes('Time not recorded'));
  assert.ok(calendarProof.text.includes('Awaiting return'));
  assert.ok(!calendarProof.text.includes('no return time yet'));
  assert.ok(calendarProof.moments.length>=10);
  assert.ok(calendarProof.moments.every(m=>m.scrollWidth<=m.width+1 && m.scrollHeight<=m.height+1),JSON.stringify(calendarProof));
  assert.ok(await ev(`[...document.querySelectorAll('[data-calendar-booking-id="qa-extension"] [data-calendar-moment="return"]')].every(e=>e.textContent.includes('Time not recorded') && !e.textContent.includes('17:30'))`));
  if(width<=700) {
    await ev(`document.querySelector('[data-calendar-agenda] [data-calendar-booking-id="qa-res"]').click()`);await pause(80);
    assert.ok(await ev(`document.querySelector('.gantt-embedded [aria-label="Close detail"]')!==null`));
    await ev(`document.querySelector('.gantt-embedded [aria-label="Close detail"]').click()`);
  }
  assert.equal(calendarProof.agenda,width<=700?'flex':'none');
  const shot=async name=>fs.writeFileSync(`${process.env.RM_QA_OUTPUT}/${name}-${width}.png`,Buffer.from((await c.cmd('Page.captureScreenshot',{captureBeyondViewport:false})).data,'base64'));
  await shot('dashboard-top');
  await ev('document.querySelector(".recharts-wrapper").scrollIntoView({block:"center"})');await pause(150);
  const bar=await ev('(()=>{const e=document.querySelector(".recharts-bar-rectangle path"); if(!e) return null;const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()');
  assert.ok(bar,'revenue bars render');
  await c.cmd('Input.dispatchMouseEvent',{type:'mouseMoved',...bar});await pause(300);
  assert.equal(await ev('document.querySelector("[data-revenue-bar-total]")?.textContent'),'Bar total£1,800');
  await shot('revenue-hover');
  await ev('document.querySelector(".gantt-embedded").scrollIntoView({block:"start"})');await pause(150);await shot('calendar');
  const geometry=await ev('(()=>{const c=document.querySelector(".gantt-embedded").getBoundingClientRect(); const r=document.querySelector("section[aria-label]").getBoundingClientRect(); return {calendarWidth:c.width,responseHeight:r.height,pageWidth:document.documentElement.scrollWidth,viewport:innerWidth}})()');
  assert.ok(geometry.pageWidth<=width+1,JSON.stringify(geometry));assert.ok(geometry.responseHeight<230,JSON.stringify(geometry));
  receipts.push({width,...geometry,checks:17});await c.close();
 }
 fs.writeFileSync(`${process.env.RM_QA_OUTPUT}/receipt.json`,JSON.stringify({receipts,realSends:0,realRentalChanges:0},null,2));
})().catch(e=>{console.error(e);process.exit(1)});
