/* Actual queue lifecycle with fixture acknowledgements. External DNS is disabled. */
const {connect}=require('./browser.cjs'),assert=require('node:assert/strict'),fs=require('node:fs');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const proof=[];
 for(const [width,height] of [[1505,1045],[1505,620],[390,844]]) {
  const c=await connect('about:blank');await c.cmd('Page.enable');
  await c.cmd('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<500});
  await c.cmd('Page.navigate',{url:process.env.RM_QA_ORIGIN});await pause(600);
  const ev=x=>c.evaluate(x);
  async function click(expr){const p=await ev(`(()=>{const e=${expr};if(!e)throw Error('Missing control: '+${JSON.stringify(expr)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);await c.cmd('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...p});await c.cmd('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...p});await pause(120);}
  const card=name=>`document.querySelector('[aria-label="Open conversation with ${name}"]')`;
  const button=text=>`[...document.querySelector('[role=dialog]').querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)})`;
  const tab=text=>`[...document.querySelectorAll('button')].find(e=>e.getAttribute('aria-label')?.startsWith(${JSON.stringify(text+' (')}))`;
  const close=`document.querySelector('[aria-label="Close conversation"]')`;
  const names=()=>ev(`[...document.querySelectorAll('[aria-label^="Open conversation with"]')].map(e=>e.getAttribute('aria-label'))`);
  const write=async text=>ev(`(()=>{const e=document.querySelector('textarea[placeholder="Write a reply…"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await ev(`void(window.__acknowledgeFixture=true)`);await click(tab('All'));
  await click(`document.querySelector('[data-thread-id="fixture-0"]')`);
  assert.equal(await ev(`document.querySelector('[role=dialog]').getAttribute('aria-modal')`),'false');
  assert.ok(await ev(`document.querySelector('[data-conversation-pane]').contains(document.querySelector('[role=dialog]'))`));
  await write('Fixture reply, no real renter.');await click(button('Send'));
  assert.ok(await ev(`!!document.querySelector('[aria-label="Close conversation"]')`),'send keeps chat open');
  await click(close);assert.equal((await names()).at(-1),'Open conversation with Marcus Lee','confirmed reply goes below every unanswered conversation');
  await click(`document.querySelector('[data-thread-id="fixture-0"]')`);
  await ev(`Object.assign(window.__fixture.rows[0],{can_deny:true,can_accept:true});window.__fixture.changed()`);await pause(80);
  await click(button('Decline'));await click(button('Confirm'));
  assert.ok(await ev(`!!document.querySelector('[aria-label="Close conversation"]')`),'decline keeps active chat');
  assert.ok(!(await names()).includes('Open conversation with Marcus Lee') || (await names()).filter(n=>n==='Open conversation with Marcus Lee').length===1,'declined primary request is hidden');
  await write('Fixture follow-up after decline.');await click(button('Send'));await click(close);
  assert.equal(await ev(`!!document.querySelector('[aria-label="Open conversation with Marcus Lee"][data-selected="true"]')`),false);
  for(const t of ['To reply','Requests','All'])await click(tab(t));
  assert.equal(await ev(`document.querySelectorAll('[aria-label="Open conversation with Marcus Lee"]').length`),1,'different-item request from the same person remains');
  await ev(`window.__fixture.rows[0].last_renter_msg_at=Date.now()+1000;window.__fixture.rows[0].last_activity_at=Date.now()+1000;window.__fixture.changed()`);await pause(120);
  assert.equal(await ev(`document.querySelectorAll('[aria-label="Open conversation with Marcus Lee"]').length`),2,'new renter message restores declined conversation');
  // Both native and website disregard are durable across filters and reload.
  for(const name of ['Daniel Kim','Priya Sharma'])await click(`${card(name)}.querySelector('[aria-label="Close thread"]')`);
  for(const t of ['To reply','Requests','All'])await click(tab(t));
  assert.ok(!(await names()).some(n=>n.includes('Daniel Kim')||n.includes('Priya Sharma')));
  await c.cmd('Page.reload');await pause(650);await click(tab('All'));
  assert.ok(!(await names()).some(n=>n.includes('Daniel Kim')||n.includes('Priya Sharma')),'reload keeps native and web preferences');
  await ev(`for(const i of [1,2]){window.__fixture.rows[i].last_sender='owner';window.__fixture.rows[i].last_activity_at=Date.now()+5000;}window.__fixture.changed();document.dispatchEvent(new Event('visibilitychange'))`);await pause(200);
  assert.ok(!(await names()).some(n=>n.includes('Daniel Kim')||n.includes('Priya Sharma')),'owner activity cannot restore hidden threads');
  await ev(`for(const i of [1,2]){window.__fixture.rows[i].last_sender='renter';window.__fixture.rows[i].last_renter_msg_at=Date.now()+10000;window.__fixture.rows[i].last_activity_at=Date.now()+10000;}window.__fixture.changed();document.dispatchEvent(new Event('visibilitychange'))`);await pause(200);
  assert.ok((await names()).some(n=>n.includes('Daniel Kim'))&&(await names()).some(n=>n.includes('Priya Sharma')),'new renter restores both sources');
  // Linked notification uses the exact same pane and close control.
  await ev(`window.history.replaceState(null,'','?thread=fixture-2');window.dispatchEvent(new CustomEvent('rm-open-thread',{detail:'fixture-2'}))`);await pause(200);
  assert.ok(await ev(`document.querySelector('[data-conversation-pane]').contains(document.querySelector('[role=dialog]'))`));
  await click(close);assert.equal(await ev(`document.querySelector('[aria-label="Close conversation"]')!==null`),false);assert.equal(await ev(`new URL(location.href).searchParams.has('thread')`),false);
  proof.push({width,height,inlinePane:true,sendDemotesImmediately:true,declineKeepsChat:true,hiddenAcrossFiltersAndReload:true,ownerDoesNotRestore:true,newRenterRestoresBothSources:true,notificationClose:true});
  await c.close();
 }
 fs.writeFileSync(process.env.RM_QA_OUTPUT+'/queue-proof.json',JSON.stringify({proof,realSends:0,realRentalChanges:0},null,2));
})().catch(e=>{console.error(e);process.exit(1)});
