const {connect}=require('./browser.cjs'),assert=require('node:assert/strict'),fs=require('node:fs');
const out=process.env.RM_QA_OUTPUT,pause=ms=>new Promise(r=>setTimeout(r,ms));
const vm=require('node:vm'),path=require('node:path');
async function workerProof(){
 const results=[];
 for(const provider of ['hygglo','website'])for(const type of ['return_reminder','rental_time_changed'])for(const mode of ['warm','ios-navigation-fails','cold']){
  const handlers={},calls=[];const url=provider==='website'?'/?thread=dbcinema%3Afixture1&account=dbcinema_web':'/?thread=fixture-2&account=dbcinema';
  const client={focus:async()=>calls.push('focus'),postMessage:data=>calls.push(data),navigate:async target=>{calls.push({navigate:target});if(mode==='ios-navigation-fails')throw Error('isolated iOS navigation failure')}};
  const self={location:{origin:'https://manager.example.invalid'},addEventListener:(name,fn)=>{handlers[name]=fn},registration:{showNotification:async(title,options)=>calls.push({title,options})},clients:{matchAll:async()=>mode==='cold'?[]:[client],openWindow:async target=>calls.push({openWindow:target})}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../../public/sw.js'),'utf8'),{self,console,URL,Uint8Array,atob});
  let pending;handlers.push({data:{json:()=>({title:type,body:'Fixture only',url})},waitUntil:p=>{pending=p}});await pending;
  const options=calls.find(c=>c.options).options;assert.equal(options.data.url,url);
  handlers.notificationclick({notification:{data:options.data,close:()=>calls.push('close')},waitUntil:p=>{pending=p}});await pending;
  if(mode==='cold')assert(calls.some(c=>c.openWindow===url));else assert(calls.some(c=>c.type==='deep-link'&&c.url===url));
  results.push({provider,type,mode,passed:true});
 }
 return results;
}
(async()=>{
 const worker=await workerProof(),results=[];
 for(const [width,height] of [[320,568],[390,844],[430,932],[844,390]]){
  const c=await connect('about:blank'),errors=[],external=[];
  try{
   await c.cmd('Page.enable');await c.cmd('Runtime.enable');await c.cmd('Network.enable');await c.cmd('Page.addScriptToEvaluateOnNewDocument',{source:'window.__qaDocumentId=Math.random().toString(36)'});
   c.on(m=>{if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description??m.params.exceptionDetails.text);if(m.method==='Network.requestWillBeSent'&&!m.params.request.url.startsWith(process.env.RM_QA_ORIGIN)&&!m.params.request.url.startsWith('data:'))external.push(m.params.request.url)});
   await c.cmd('Network.setBlockedURLs',{urls:['*convex.cloud*','*convex.site*','*hygglo*','*vercel.app*','*dbcinemarentals.com*']});
   await c.cmd('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:true});await c.cmd('Emulation.setTouchEmulationEnabled',{enabled:true});
   const ev=x=>c.evaluate(x);
   async function waitFor(x){for(let i=0;i<100;i++){if(await ev(x))return;await pause(50)}throw Error('Timeout: '+x)}
   async function tap(x){await waitFor(`!!(${x})`);const r=await ev(`(()=>{const e=${x};e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);assert(r.x>=0&&r.x<=width&&r.y>=0&&r.y<=height,'Tap target off screen '+JSON.stringify(r));await c.cmd('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[r]});await c.cmd('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await pause(100)}
   const bell=`document.querySelector('button[aria-label="Notifications"]')`,close=`document.querySelector('[data-testid="quick-reply-close"]')`;
   async function assertOpen(event){
    await waitFor(`!!document.querySelector('[role="dialog"][aria-label^="Conversation with "]')`);
    const state=await ev(`(()=>{const dialogs=[...document.querySelectorAll('[role="dialog"][aria-label^="Conversation with "]')],d=dialogs[0],r=d.getBoundingClientRect(),b=d.querySelector('[data-testid="quick-reply-close"]').getBoundingClientRect();return {count:dialogs.length,label:d.getAttribute('aria-label'),inline:!!d.closest('[data-conversation-pane]'),url:location.href,closeVisible:b.top>=0&&b.bottom<=innerHeight&&b.left>=0&&b.right<=innerWidth,width:r.width,overflow:document.documentElement.scrollWidth-innerWidth,calls:window.__calls}})()`);
    const u=new URL(state.url);assert.equal(u.searchParams.get('thread'),event.thread_id);assert.equal(u.searchParams.get('account'),event.account_slug);assert.equal(state.count,1);assert.equal(state.label,'Conversation with '+event.name);assert(state.inline&&state.closeVisible&&state.overflow<=1,JSON.stringify(state));
    if(event.thread_id.startsWith('dbcinema:'))assert(state.calls.some(c=>c.name==='dbcinema_chat:thread'&&c.args.booking_id===event.thread_id.slice(9)),'Wrong website booking requested');
    return state;
   }
   async function assertClosed(){await tap(close);await waitFor(`!document.querySelector('[role="dialog"][aria-label^="Conversation with "]')`);const u=new URL(await ev('location.href'));assert(!u.searchParams.has('thread'));assert.equal(u.searchParams.get('keep'),'1');assert.equal(u.hash,'#quick-reply');await ev(`window.__fixture.changed()`);await pause(100);assert.equal(await ev(`document.querySelectorAll('[role="dialog"][aria-label^="Conversation with "]').length`),0)}
   await c.cmd('Page.navigate',{url:process.env.RM_QA_ORIGIN});await waitFor('!!window.__notificationFixture');
   const events=await ev(`window.__notificationFixture.events.map(e=>({...e,name:window.__fixture.rows.find(r=>r.thread_id===e.thread_id).renter_name}))`);
   const checks=[];
   for(const event of events){
    const alert=`[...document.querySelectorAll('[aria-label="Notification menu"] button')].find(b=>b.textContent.includes(${JSON.stringify(event.title)})&&b.textContent.includes(${JSON.stringify(event.name)}))`;
    for(let reopen=0;reopen<2;reopen++){
     await tap(bell);await tap(alert);const state=await assertOpen(event);
     if(reopen===0)fs.writeFileSync(`${out}/notification-${event.type}-${event.thread_id.startsWith('dbcinema:')?'web':'hygglo'}-${width}.png`,Buffer.from((await c.cmd('Page.captureScreenshot')).data,'base64'));
     if(reopen===0)await ev('window.__frozenSearchParams=location.search');
     if(reopen===1)await ev(`delete window.__frozenSearchParams;window.dispatchEvent(new Event('qa-navigation'))`);
     await assertClosed();checks.push({type:event.type,provider:event.thread_id.startsWith('dbcinema:')?'website':'hygglo',entry:'bell',reopen:!!reopen,passed:true});
    }
    const previousDocument=await ev('window.__qaDocumentId');await c.cmd('Page.navigate',{url:process.env.RM_QA_ORIGIN+event.url.replace('/?','/?deferred=1&')});await waitFor(`!!window.__mountInbox&&window.__qaDocumentId!==${JSON.stringify(previousDocument)}`);assert.equal(await ev(`document.querySelectorAll('[role="dialog"][aria-label^="Conversation with "]').length`),0);await ev('window.__mountInbox()');await assertOpen(event);await assertClosed();checks.push({type:event.type,provider:event.thread_id.startsWith('dbcinema:')?'website':'hygglo',entry:'cold deferred URL',passed:true});
    await ev(`navigator.serviceWorker.dispatchEvent(new MessageEvent('message',{data:{type:'deep-link',url:${JSON.stringify(event.url)}}}))`);await assertOpen(event);await assertClosed();checks.push({type:event.type,provider:event.thread_id.startsWith('dbcinema:')?'website':'hygglo',entry:'mobile service worker message',passed:true});
   }
   const unsafe=await ev(`window.__calls.filter(c=>/send|approve|decline|refund|setDates|setPrice|addItem|removeItem|acceptBasket|draftReply|generateDraft/i.test(c.name))`);assert.deepEqual(unsafe,[]);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);results.push({width,height,checks,noExternalRequests:true,noWriteOrDraftCalls:true});console.log('PASS notification links '+width+'x'+height+' '+checks.length+' cases');
  }catch(e){fs.writeFileSync(`${out}/failure-${width}.json`,JSON.stringify({errors,external,state:await c.evaluate(`({url:location.href,text:document.body.innerText,calls:window.__calls})`)},null,2));fs.writeFileSync(`${out}/failure-${width}.png`,Buffer.from((await c.cmd('Page.captureScreenshot')).data,'base64'));throw e}finally{await c.closePage();c.close()}
 }
 fs.writeFileSync(out+'/notification-links.json',JSON.stringify({passed:true,worker,results,realRenterMessages:0,realRentalChanges:0,realNotificationWrites:0},null,2));
})().catch(e=>{console.error(e);process.exitCode=1});
