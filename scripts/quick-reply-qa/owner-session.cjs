const { connect } = require("./browser.cjs");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  for (const width of [320, 1500]) {
    const client = await connect("about:blank");
    try {
      await client.cmd("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width < 768 });
      await client.cmd("Page.navigate", { url: `${process.env.RM_QA_ORIGIN}/?no-owner=1` });
      for (let attempt = 0; attempt < 100 && !await client.evaluate(`!!document.querySelector('a[href="/login"]')`); attempt++) await pause(100);
      const result = await client.evaluate(`(()=>({link:document.querySelector('a[href="/login"]')?.textContent,calls:window.__calls.filter(c=>c.name.startsWith('dbcinema_chat:')),otherDashboard:!!document.querySelector('input[aria-label="Search conversations"]'),overflow:document.documentElement.scrollWidth-innerWidth}))()`);
      assert.match(result.link, /Sign in for DB Cinema/); assert.equal(result.calls.length, 0); assert(result.otherDashboard); assert(result.overflow <= 1, JSON.stringify(result));
      fs.writeFileSync(`${process.env.RM_QA_OUTPUT}/owner-signin-${width}.png`, Buffer.from((await client.cmd("Page.captureScreenshot")).data, "base64"));
      await client.cmd("Page.navigate", { url: process.env.RM_QA_ORIGIN });
      for (let attempt = 0; attempt < 100 && !await client.evaluate(`window.__calls?.some(c=>c.name==='dbcinema_chat:inbox')`); attempt++) await pause(100);
      assert(await client.evaluate(`window.__calls.some(c=>c.name==='dbcinema_chat:inbox') && window.__calls.some(c=>c.name==='dbcinema_chat:emailInbox')`), "an authenticated owner loads both protected inboxes");
      assert.equal(await client.evaluate(`!!document.querySelector('a[href="/login"]')`), false);
    } finally { client.close(); await client.closePage(); }
  }
  console.log("PASS optional owner sign-in: protected chat stays closed, dashboard remains open at mobile and desktop widths.");
})().catch(error => { console.error(error); process.exitCode = 1; });
