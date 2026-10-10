const { connect } = require("./browser.cjs"),
  assert = require("node:assert/strict"),
  fs = require("fs");
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const results = [];
  for (const [width, height, mockKeyboard] of [
    [390, 844, false],
    [390, 844, true],
    [390, 568, false],
    [390, 390, false],
    [320, 568, false],
    [768, 1024, false],
    [844, 390, false],
    [1100, 900, false],
  ]) {
    const c = await connect("about:blank");
    await c.cmd("Page.enable");
    await c.cmd("Network.enable");
    await c.cmd("Network.setBlockedURLs", {
      urls: [
        "*convex.cloud*",
        "*convex.site*",
        "*hygglo*",
        "*vercel.app*",
        "*dbcinemarentals.com*",
      ],
    });
    await c.cmd("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await c.cmd("Emulation.setTouchEmulationEnabled", { enabled: true });
    if (mockKeyboard)
      await c.cmd("Page.addScriptToEvaluateOnNewDocument", {
        source: `{const viewport=new EventTarget();Object.assign(viewport,{height:844,width:390,offsetTop:0,offsetLeft:0,scale:1});Object.defineProperty(window,'visualViewport',{value:viewport,configurable:true});window.__qaViewport=viewport;}`,
      });
    await c.cmd("Page.navigate", { url: process.env.RM_QA_ORIGIN });
    await pause(300);
    const ev = (x) => c.evaluate(x);
    async function tap(expr) {
      const r = await ev(
        `(()=>{const e=${expr};if(!e)throw Error('Missing target');e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`,
      );
      await c.cmd("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [r],
      });
      await c.cmd("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      await pause(80);
    }
    const open = `document.querySelector('[aria-label="Open conversation with Marcus Lee"]')`,
      close = `document.querySelector('[aria-label="Close conversation"]')`,
      btn = (t) =>
        `[...document.querySelector('[role=dialog]').querySelectorAll('button')].find(e=>e.offsetParent!==null&&e.textContent.includes(${JSON.stringify(t)}))`;
    const states = [];
    for (const state of ["composer", "quick text", "calendar", "reviews"]) {
      await tap(open);
      if (state === "reviews")
        await tap(
          `document.querySelector('[title="View all renter reviews"]')`,
        );
      else {
        await tap(
          `document.querySelector('[aria-label="Write reply or insert text file"]')`,
        );
        if (state === "quick text") await tap(btn("Customize"));
        if (state === "calendar") {
          if (width <= 640) await tap(btn("Booking actions"));
          else {
            await tap(`document.querySelector('summary')`);
            await tap(btn("Reschedule"));
          }
          if (width <= 640)
            await tap(
              `document.querySelector('[title="Change the rental dates"]')`,
            );
        }
      }
      if (mockKeyboard) {
        await ev(
          `{Object.assign(window.__qaViewport,{height:390,offsetTop:80});window.__qaViewport.dispatchEvent(new Event('resize'));}`,
        );
        await pause(100);
      }
      const geometry = await ev(
        `(()=>{const e=${close},r=e.getBoundingClientRect(),send=[...document.querySelector('[role=dialog]').querySelectorAll('button')].find(e=>e.textContent.trim()==='Send'),s=send.getBoundingClientRect();return {hit:e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)),closeInside:r.top>=(window.visualViewport?.offsetTop??0)&&r.bottom<=(window.visualViewport?.height??innerHeight)+(window.visualViewport?.offsetTop??0),sendInside:s.top>=(window.visualViewport?.offsetTop??0)&&s.bottom<=(window.visualViewport?.height??innerHeight)+(window.visualViewport?.offsetTop??0),viewport:innerHeight};})()`,
      );
      assert(
        geometry.hit && geometry.closeInside,
        JSON.stringify({ width, height, state, geometry }),
      );
      if (state === "composer")
        assert(
          geometry.sendInside,
          JSON.stringify({
            width,
            height,
            mockKeyboard,
            state,
            geometry,
            boxes: await ev(
              `[...document.querySelector('[role=dialog]').children].map(e=>({class:e.className,rect:e.getBoundingClientRect().toJSON(),child:[...e.children].map(x=>({class:x.className,rect:x.getBoundingClientRect().toJSON()}))}))`,
            ),
          }),
        );
      await tap(close);
      assert(await ev(`!document.querySelector('[role=dialog]')`));
      states.push({ state, ...geometry });
    }
    assert(await ev('!window.__calls.some(c=>c.kind===\"mutation\")'));
    results.push({ width, height, mockKeyboard: !!mockKeyboard, states });
    await c.closePage();
    c.close();
  }
  fs.writeFileSync(
    process.env.RM_QA_OUTPUT + "/phone-close-proof.json",
    JSON.stringify(results, null, 2),
  );
  console.log(
    results.map((r) => ({
      width: r.width,
      height: r.height,
      passed: r.states.length,
    })),
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
