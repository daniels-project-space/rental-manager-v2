/* Actual component layout; isolated transport, no real renter operations. */
const { connect } = require("./browser.cjs");
const fs = require("node:fs"),
  assert = require("node:assert/strict");
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const proof = [];
  for (const width of [1505, 1192, 1024, 768, 390, 320]) {
    const c = await connect("about:blank");
    try {
      await c.cmd("Network.enable");
      await c.cmd("Network.setBlockedURLs", {
        urls: ["*convex*", "*hygglo*", "*vercel.app*", "*dbcinemarentals.com*"],
      });
      await c.cmd("Emulation.setDeviceMetricsOverride", {
        width,
        height: 1045,
        deviceScaleFactor: 1,
        mobile: width < 768,
      });
      await c.cmd("Page.navigate", { url: process.env.RM_QA_ORIGIN });
      for (let i = 0; i < 100; i++) {
        if (
          await c.evaluate(`!!document.querySelector('[class*="handoffRail"]')`)
        )
          break;
        await pause(100);
      }
      const inspect = () =>
        c.evaluate(
          `(()=>{const rail=document.querySelector('[class*="handoffRail"]'),box=rail.getBoundingClientRect();return {width:innerWidth,railWidth:box.width,overflow:document.documentElement.scrollWidth-innerWidth,cards:[...rail.querySelectorAll('button')].map(card=>{const r=card.getBoundingClientRect(),n=card.querySelector('[class*="handoffRenter"]'),nr=n.getBoundingClientRect(),timing=card.querySelector('[class*="handoffTiming"]').getBoundingClientRect(),identity=card.querySelector('[class*="handoffIdentity"]').getBoundingClientRect();return {name:n.textContent,visible:nr.width>0&&nr.height>0,nameFits:n.scrollWidth<=n.clientWidth,time:card.querySelector('time').textContent,height:r.height,inside:nr.left>=r.left&&nr.right<=r.right&&identity.bottom<=r.bottom+1,noOverlap:nr.bottom<=timing.top+1&&timing.bottom<=identity.top+1}})}})()`,
        );
      const check = async (stage) => {
        const p = await inspect();
        assert(p.overflow <= 1, JSON.stringify(p));
        assert(p.cards.length === 2);
        assert(
          p.cards.every(
            (x) =>
              x.visible &&
              x.nameFits &&
              x.inside &&
              x.noOverlap &&
              x.height <= 100 &&
              /\d\d:\d\d/.test(x.time),
          ),
          JSON.stringify(p),
        );
        proof.push({ stage, ...p });
        await c.evaluate(
          `document.querySelector('[class*="handoffRail"]').scrollIntoView({block:'start'})`,
        );
        await pause(100);
        fs.writeFileSync(
          `${process.env.RM_QA_OUTPUT}/handoffs-${stage}-${width}.png`,
          Buffer.from((await c.cmd("Page.captureScreenshot")).data, "base64"),
        );
      };
      await check("queue");
      await c.evaluate(
        `document.querySelector('[aria-label="pickup with Marcus Lee"]').click()`,
      );
      await pause(200);
      assert(
        await c.evaluate(
          `!!document.querySelector('[aria-label="Close conversation"]')`,
        ),
        "Card must open the conversation",
      );
      if (width >= 900) await check("chat-open");
      await c.evaluate(
        `document.querySelector('[aria-label="Close conversation"]').click()`,
      );
      await pause(150);
      await check("closed");
      await c.evaluate(
        `document.querySelector('[aria-label="return with Priya Sharma"]').scrollIntoView({block:'nearest',inline:'nearest'});document.querySelector('[aria-label="return with Priya Sharma"]').click()`,
      );
      await pause(150);
      assert(
        await c.evaluate(
          `!!document.querySelector('[aria-label="Conversation with Priya Sharma"]')`,
        ),
        "Return card must open its own conversation",
      );
      await c.evaluate(
        `document.querySelector('[aria-label="Close conversation"]').click()`,
      );
      await pause(100);
      assert.equal(
        await c.evaluate(
          `window.__calls.filter(x=>x.name.includes('send')||x.name.includes('apply')).length`,
        ),
        0,
      );
    } finally {
      await c.closePage();
      c.close();
    }
  }
  fs.writeFileSync(
    process.env.RM_QA_OUTPUT + "/handoffs-proof.json",
    JSON.stringify(proof, null, 2),
  );
  console.log(
    "Handoff formatting and open/close passed at six widths; no sends or rental changes.",
  );
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
