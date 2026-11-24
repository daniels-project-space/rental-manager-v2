/* Check the later spacious-chat layout at the original reference canvas size. */
const {connect}=require('./browser.cjs');
const fs=require('node:fs'),assert=require('node:assert/strict');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
 const c=await connect('about:blank');
 await c.cmd('Emulation.setDeviceMetricsOverride',{width:1193,height:992,deviceScaleFactor:1,mobile:false});
 await c.cmd('Page.navigate',{url:process.env.RM_QA_ORIGIN});
 for(let i=0;i<100;i++){if(await c.evaluate(`!!document.querySelector('[data-thread-id]')`))break;await pause(50);}
 await c.evaluate(`(()=>{const root=document.querySelector('#root');root.style.padding='0';root.style.width='1125px';root.style.margin='1px 0 0 68px';})()`);
 await pause(250);
 const actual=await c.evaluate(`(()=>{
 const row=document.querySelector('[data-thread-id]'), title=document.querySelector('h2'), pane=document.querySelector('[data-conversation-pane]'), list=row.parentElement;
 const rowRect=row.getBoundingClientRect(),avatar=row.querySelector('img').getBoundingClientRect(),paneRect=pane.getBoundingClientRect(),listRect=list.getBoundingClientRect();
 const toolbar=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='To reply').getBoundingClientRect();
 return {titleFont:parseFloat(getComputedStyle(title).fontSize),toolbarHeight:toolbar.height,rowHeight:rowRect.height,portraitWidth:avatar.width,portraitHeight:avatar.height,queueShare:listRect.width/(listRect.width+paneRect.width),paneWidth:paneRect.width,queueWidth:listRect.width};})()`);
 const bounds={titleFont:[21,23],toolbarHeight:[36,41],rowHeight:[112,145],portraitWidth:[48,52],portraitHeight:[48,52],queueShare:[.22,.29]};
 for(const [key,[minimum,maximum]] of Object.entries(bounds))assert(actual[key]>=minimum&&actual[key]<=maximum,`${key}: actual ${actual[key]}, expected ${minimum}–${maximum}`);
 fs.writeFileSync(`${process.env.RM_QA_OUTPUT}/reference-desktop.png`,Buffer.from((await c.cmd('Page.captureScreenshot',{captureBeyondViewport:false})).data,'base64'));
 fs.writeFileSync(`${process.env.RM_QA_OUTPUT}/reference-measurements.json`,JSON.stringify({bounds,actual,note:'PR #133 replaced the earlier 65% list / 35% chat reference with a spacious chat and a narrower list. These bounds check that later layout; they do not claim pixel equality with the original render.',realSends:0,realRentalChanges:0},null,2));
 await c.closePage();
})().catch(error=>{console.error(error);process.exitCode=1});
