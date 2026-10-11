/* Actual photo nodes fan in a fixed slot. No production APIs or write transports. */
const {connect}=require('./browser.cjs'),fs=require('node:fs'),assert=require('node:assert/strict');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const proofs=[];
 for(const width of [1505,390]){
  const c=await connect('about:blank');await c.cmd('Emulation.setDeviceMetricsOverride',{width,height:1045,deviceScaleFactor:1,mobile:width===390});
  await c.cmd('Emulation.setTouchEmulationEnabled',{enabled:width===390});
  await c.cmd('Page.navigate',{url:process.env.RM_QA_ORIGIN});await pause(600);
  await c.evaluate(`void(window.__fixture.rows[0].requested_items=[window.__fixture.rows[0].items[0],{name:'Sigma 24-70',qty:1,image_url:'/gear1.png'},{name:'Aputure 600d',qty:1,image_url:'/gear2.png'}]);window.__fixture.changed()`);await pause(300);
  const ev=x=>c.evaluate(x),stack=`document.querySelector('[aria-label="Open conversation with Marcus Lee"] [data-requested-stack]')`;
  const snapshot=()=>ev(`(()=>{const s=${stack},row=s.closest('[aria-label^="Open conversation"]');const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}};return {slot:rect(s),row:rect(row),next:rect(row.nextElementSibling),pageWidth:document.documentElement.scrollWidth,pageHeight:document.documentElement.scrollHeight,expanded:s.dataset.expanded,transforms:[...s.querySelectorAll('[data-stack-layer]')].map(e=>getComputedStyle(e).transform)}})()`);
  await ev(`void(window.__stackNodes=[...${stack}.querySelectorAll('img')])`);const before=await snapshot();
  const point=await ev(`(()=>{const r=${stack}.getBoundingClientRect();return {x:r.x+10,y:r.y+10}})()`);
  if(width===390){await c.cmd('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...point,radiusX:1,radiusY:1,force:1}]});await c.cmd('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});}
  else await c.cmd('Input.dispatchMouseEvent',{type:'mouseMoved',...point});
  await pause(70);const during=await snapshot();await pause(260);const after=await snapshot();
  assert.equal(after.expanded,'true');
  for(const key of ['slot','row','next','pageWidth','pageHeight']){assert.deepEqual(during[key],before[key],`hover changed ${key} at ${width}px`);assert.deepEqual(after[key],before[key],`fan changed ${key} at ${width}px`);}
  assert.notDeepEqual(after.transforms,before.transforms,'photo layers actually move apart');
  if(width===1505)assert.notDeepEqual(during.transforms,after.transforms,'layers animate instead of swapping a grid');
  assert.ok(await ev(`!${stack}.querySelector('section')`),'no second equipment overlay/grid');
  assert.ok(await ev(`window.__stackNodes.every((node,i)=>node===${stack}.querySelectorAll('img')[i]&&node.complete&&node.naturalWidth>0)`),'existing loaded image nodes are preserved');
  fs.writeFileSync(`${process.env.RM_QA_OUTPUT}/stack-fan-${width}.png`,Buffer.from((await c.cmd('Page.captureScreenshot',{captureBeyondViewport:false})).data,'base64'));
  if(width===390){await c.cmd('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:width-8,y:12,radiusX:1,radiusY:1,force:1}]});await c.cmd('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});}
  else await c.cmd('Input.dispatchMouseEvent',{type:'mouseMoved',x:width-8,y:12});
  await pause(300);const collapsed=await snapshot();assert.equal(collapsed.expanded,'false');assert.deepEqual(collapsed.slot,before.slot);assert.deepEqual(collapsed.transforms,before.transforms);
  proofs.push({width,fixedGeometry:true,samePhotoNodes:true,animatedFan:true,foldsBack:true});await c.close();
 }
 fs.writeFileSync(`${process.env.RM_QA_OUTPUT}/stack-fan-proof.json`,JSON.stringify({proofs,realSends:0,realRentalChanges:0},null,2));
})().catch(e=>{console.error(e);process.exit(1)});
