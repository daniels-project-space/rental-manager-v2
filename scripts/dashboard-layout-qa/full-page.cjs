const {connect}=require('../quick-reply-qa/browser.cjs');
const fs=require('node:fs'),assert=require('node:assert/strict');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
 const proof=[],reads=new Map();
 for(const width of [1505,768,430,390,320]) {
  const c=await connect('about:blank'),errors=[];
  c.on(event=>{if(event.method==='Runtime.exceptionThrown')errors.push(event.params.exceptionDetails.exception?.description??event.params.exceptionDetails.text);if(event.method==='Runtime.consoleAPICalled'&&event.params.type==='error')errors.push(event.params.args.map(a=>a.description??a.value??'').join(' ').slice(0,2500)+' '+JSON.stringify(event.params.stackTrace?.callFrames?.slice(0,16)));});
  await c.cmd('Runtime.enable');await c.cmd('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:width<800});
  await c.cmd('Page.navigate',{url:process.env.RM_QA_ORIGIN});
  await pause(1500);
  await c.evaluate(`document.querySelector('#root').style.padding='0'`);
  for(let pass=0;pass<15;pass++){await c.evaluate(`window.scrollBy(0,innerHeight*.9)`);await pause(100);}
  await pause(300);
  const state=await c.evaluate(`(()=>{const cards=[...document.querySelectorAll('[data-widget-id]')].map(e=>{const r=e.getBoundingClientRect();return{id:e.dataset.widgetId,x:r.x,right:r.right,y:r.y,bottom:r.bottom,scroll:e.scrollWidth,client:e.clientWidth}});return{width:innerWidth,pageWidth:document.documentElement.scrollWidth,cards,missing:[...window.__qaMissing??[]],reads:[...window.__qaReads.values()],errorText:[...document.querySelectorAll('[data-widget-id]')].filter(e=>e.textContent.includes('failed to render')).map(e=>e.textContent),statsText:document.querySelector('[data-widget-id=stats-grid]').textContent.slice(0,1000)}})()`);
  state.reads.forEach(row=>reads.set(row.name,row));delete state.reads;
  fs.writeFileSync(`${process.env.RM_QA_OUTPUT}/read-descriptors.json`,JSON.stringify([...reads.values()],null,2));
  fs.writeFileSync(`${process.env.RM_QA_OUTPUT}/full-page-${width}.json`,JSON.stringify({state,errors},null,2));
  assert.equal(errors.length,0,errors.join('\n'));
  assert.ok(state.cards.length>=30,'actual page includes the complete dashboard');
  const primary=state.cards.filter(card=>['stats-grid','lifetime','reply-inbox','live-calendar','return-hub'].includes(card.id));
  assert.equal(primary.length,5);
  assert.ok(primary.every(card=>Math.abs(card.client-primary[0].client)<2),'primary panels use the whole page width');
  assert.ok(state.pageWidth<=width+1,`page overflow at ${width}`);
  for(const id of ['conversation_funnel','channel_response_rates']) {
    const card=state.cards.find(row=>row.id===id);assert.ok(card&&card.scroll<=card.client+1,`${id} overflow at ${width}`);
  }
  for(const [label,selector] of [['top','header'],['quick-reply','[data-widget-id="reply-inbox"]'],['calendar','[data-widget-id="live-calendar"]'],['secondary','[data-widget-id="return-hub"]']]) {
    await c.evaluate(label==='top'?`window.scrollTo(0,0)`:`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'start'})`);await pause(150);
    fs.writeFileSync(`${process.env.RM_QA_OUTPUT}/full-${label}-${width}.png`,Buffer.from((await c.cmd('Page.captureScreenshot',{captureBeyondViewport:false})).data,'base64'));
  }
  assert.deepEqual(state.missing,[],'every actual page query must have a read snapshot');
  const thread=await c.evaluate(`document.querySelector('[data-thread-id]')?.dataset.threadId`);
  assert.ok(thread,'real queue data is displayed');
  for(const notification of [false,true]) {
    await c.evaluate(notification?`window.dispatchEvent(new CustomEvent('rm-open-thread',{detail:${JSON.stringify(thread)}}))`:`document.querySelector('[data-thread-id]').click()`);await pause(350);
    const close=await c.evaluate(`(()=>{const b=document.querySelector('[aria-label="Close conversation"]');const r=b.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;const hit=document.elementFromPoint(x,y);return{x,y,reachable:b===hit||b.contains(hit),headerBottom:document.querySelector('[data-manager-header]').getBoundingClientRect().bottom,dialogs:document.querySelectorAll('[role=dialog]').length}})()`);
    assert.ok(close.reachable,`actual page header covers close: ${JSON.stringify({width,...close})}`);
    assert.equal(close.dialogs,1);
    const dock=await c.evaluate(`(()=>{const d=document.querySelector('[role=dialog]').getBoundingClientRect(),s=document.querySelector('[data-quick-reply-split]').getBoundingClientRect();return{width:d.width,splitWidth:s.width}})()`);
    if(width>=900)assert.ok(dock.width/dock.splitWidth>=.49&&dock.width/dock.splitWidth<=.51,'actual page chat expands to half the workspace');
    await c.cmd('Input.dispatchMouseEvent',{type:'mousePressed',x:close.x,y:close.y,button:'left',clickCount:1});
    await c.cmd('Input.dispatchMouseEvent',{type:'mouseReleased',x:close.x,y:close.y,button:'left',clickCount:1});await pause(180);
    assert.equal(await c.evaluate(`document.querySelectorAll('[role=dialog]').length`),0,'physical close works in the actual page');
  }
  state.actualPageNormalClose=true;state.actualPageNotificationClose=true;
  proof.push(state);await c.closePage();
 }
 fs.writeFileSync(`${process.env.RM_QA_OUTPUT}/read-descriptors.json`,JSON.stringify([...reads.values()],null,2));
 fs.writeFileSync(`${process.env.RM_QA_OUTPUT}/full-page-receipt.json`,JSON.stringify({proof,realSends:0,realRentalChanges:0,fixtureTransport:true},null,2));
 console.log('Full actual dashboard page passed at five widths.');
})().catch(error=>{console.error(error);process.exitCode=1});
