/* Captures the real components using only the isolated QA transport. */
const { connect } = require("./browser.cjs");
const fs = require("node:fs");
const assert = require("node:assert/strict");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
(async () => {
  const results = [];
  for (const width of [1505, 390]) {
    const c = await connect("about:blank");
    await c.cmd("Network.enable");
    await c.cmd("Network.setBlockedURLs", {
      urls: ["*convex*", "*hygglo*", "*vercel.app*", "*dbcinemarentals.com*"],
    });
    await c.cmd("Emulation.setDeviceMetricsOverride", {
      width,
      height: width === 390 ? 844 : 1045,
      deviceScaleFactor: 1,
      mobile: width === 390,
    });
    await c.cmd("Emulation.setTouchEmulationEnabled", {
      enabled: width === 390,
    });
    await c.cmd("Page.navigate", { url: process.env.RM_QA_ORIGIN });
    await pause(500);
    const ev = (x) => c.evaluate(x);
    const capture = async (name) => {
      await pause(150);
      fs.writeFileSync(
        `${process.env.RM_QA_OUTPUT}/${name}-${width}.png`,
        Buffer.from(
          (
            await c.cmd("Page.captureScreenshot", {
              captureBeyondViewport: false,
            })
          ).data,
          "base64",
        ),
      );
    };
    await ev(
      `{window.__fixture.rows[2].account_slug='diogo';window.__fixture.rows[5].account_slug='leo';window.__fixture.rows[0].requested_items=[...window.__fixture.rows[0].items.map(i=>({...i,origin:'basket'})),{name:'Sigma 24-70',qty:1,image_url:'/gear1.png',origin:'chat'},{name:'Manfrotto Tripod',qty:1,image_url:'/gear2.png',origin:'chat'}];window.__fixture.changed();[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='All').click();}`,
    );
    const search = async (value) => {
      await ev(
        `{const input=document.querySelector('[aria-label="Search conversations"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));}`,
      );
      await pause(100);
    };
    await ev(
      `{window.__fixture.rows[0].search_text='The owner mentioned bouncy castle scheduling';window.__fixture.changed();}`,
    );
    await search("bouncy castle");
    assert.equal(
      await ev(
        `document.querySelectorAll('[aria-label^="Open conversation with"]').length`,
      ),
      1,
      "words in recent conversation filter the queue",
    );
    await ev(
      `{window.__fixture.rows[0].history_messages=Array.from({length:53},(_,i)=>i===51?'acetate':i===52?'screening':'ordinary archived text');window.__fixture.rows[1].history_messages=Array.from({length:49},(_,i)=>i===48?'cinetape':'ordinary archived text');window.__fixture.changed();}`,
    );
    await search("Marcus acetate screening");
    await pause(450);
    assert(
      await ev(
        `document.querySelectorAll('[aria-label^="Open conversation with"]').length===1&&!!document.querySelector('[aria-label="Open conversation with Marcus Lee"]')`,
      ),
      "name and words across older native message pages filter the queue",
    );
    await capture("history-search");
    await search("Priya cinetape");
    await pause(450);
    assert(
      await ev(
        `document.querySelectorAll('[aria-label^="Open conversation with"]').length===1&&!!document.querySelector('[aria-label="Open conversation with Priya Sharma"]')`,
      ),
      "older website messages filter their account's requests",
    );
    await ev(`{window.__historyFailure=true;}`);
    await search("acetate");
    await pause(450);
    assert(
      await ev(
        `!!document.querySelector('[aria-label="Retry message history search"]')`,
      ),
      "history failures offer a controlled retry",
    );
    await capture("search-unavailable");
    await ev(
      `{window.__historyFailure=false;document.querySelector('[aria-label="Retry message history search"]').click();}`,
    );
    await pause(450);
    assert(
      await ev(
        `document.querySelectorAll('[aria-label^="Open conversation with"]').length===1&&!document.querySelector('[aria-label="Retry message history search"]')`,
      ),
      "history retry restores results without sending or drafting",
    );
    await ev(
      `{window.__fixture.rows[0].history_messages[0]='acetate';window.__historyDelay=300;}`,
    );
    await search("acetate screening");
    await pause(230);
    await ev(`{window.__historyDelay=0;}`);
    await search("Priya");
    await pause(650);
    assert(
      await ev(
        `document.querySelectorAll('[aria-label^="Open conversation with"]').length===1&&!!document.querySelector('[aria-label="Open conversation with Priya Sharma"]')`,
      ),
      "late history responses cannot restore an old search",
    );
    await search("");
    await pause(350);
    const historyIdleCalls = await ev(
      `window.__calls.filter(call=>call.name==='quick_reply_search:page').length`,
    );
    await ev(`window.__fixture.changed()`);
    await pause(350);
    assert.equal(
      await ev(
        `window.__calls.filter(call=>call.name==='quick_reply_search:page').length`,
      ),
      historyIdleCalls,
      "cleared search and incoming updates do not read message history",
    );
    await search("");
    await ev(
      `[...document.querySelector('[aria-label="Filter conversations by account"]').querySelectorAll('button')].find(b=>b.textContent.trim()==='Leo Adams').click()`,
    );
    await pause(100);
    assert.equal(
      await ev(
        `document.querySelectorAll('[aria-label^="Open conversation with"]').length`,
      ),
      1,
      "account filter isolates the requested account",
    );
    assert.equal(
      await ev(
        `document.querySelector('[aria-label^="Open conversation with"]').style.getPropertyValue('--account-accent')`,
      ),
      "#a855f7",
      "account row uses the calendar accent",
    );
    await ev(
      `[...document.querySelector('[aria-label="Filter conversations by account"]').querySelectorAll('button')].find(b=>b.textContent.trim()==='All accounts').click()`,
    );
    await pause(100);
    if (width === 1505) {
      assert(
        await ev(
          `!!document.querySelector('[aria-label^="Request preview for"]')`,
        ),
        "closed desktop shows a request preview",
      );
      assert.equal(
        await ev(
          `window.__calls.filter(c=>c.name==='replyInbox_actions:generateDraft'||c.name==='dbcinema_chat:draftReply').length`,
        ),
        0,
        "closed preview does not draft",
      );
      await ev(
        `document.querySelector('[aria-label="Open conversation with Marcus Lee"]').dispatchEvent(new MouseEvent('mouseover',{bubbles:true,relatedTarget:document.body}))`,
      );
      await pause(100);
      assert(
        await ev(
          `!!document.querySelector('[aria-label="Request preview for Marcus Lee"]')`,
        ),
        "hover updates the real request preview",
      );
      assert.equal(
        await ev(
          `window.__calls.filter(c=>c.name==='replyInbox_actions:generateDraft'||c.name==='dbcinema_chat:draftReply').length`,
        ),
        0,
        "hover does not draft",
      );
    }
    const handoffSummary = await ev(
      `(()=>{const rail=document.querySelector('[class*="handoffRail"]');const heading=rail.querySelector('[class*="handoffIntro"]');return {headingVisible:getComputedStyle(heading).display!=='none',nameCount:rail.querySelectorAll('[class*="handoffRenter"]').length,cardCount:rail.querySelectorAll('button').length};})()`,
    );
    assert(
      handoffSummary.headingVisible,
      "time-sensitive rail keeps its heading visible at every viewport",
    );
    assert.equal(
      handoffSummary.nameCount,
      handoffSummary.cardCount,
      "every time-sensitive rental displays the renter name",
    );
    await capture("queue");
    if (width === 1505) {
      await ev(
        `{const item=window.__fixture.rows[0].requested_items[0];item.image_url='/missing-primary.png';item.image_urls=['/gear0.png'];window.__fixture.changed();}`,
      );
      await pause(150);
      const stack =
        "document.querySelector('[aria-label=\"Open conversation with Marcus Lee\"] [data-requested-stack]')";
      assert(
        await ev(
          `(()=>{const img=${stack}.querySelector('img');return img?.complete&&img.naturalWidth>0&&img.src.endsWith('/gear0.png');})()`,
        ),
        "failed primary equipment image uses the loaded fallback",
      );
      assert(
        await ev(
          `(()=>{const img=document.querySelector('[aria-label="pickup with Marcus Lee"] [class*="handoffGear"] img');return img?.complete&&img.naturalWidth>0&&img.src.endsWith('/gear0.png');})()`,
        ),
        "time-sensitive rental gear shares the verified image fallback",
      );
      const point = await ev(
        `(()=>{const r=${stack}.getBoundingClientRect();return {x:r.x+10,y:r.y+10};})()`,
      );
      await c.cmd("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
      await pause(150);
      assert(
        await ev(`${stack}.querySelectorAll('section img').length===3`),
        "all requested images expand in the card: " +
          (await ev(
            `JSON.stringify({expanded:${stack}.dataset.expanded,hoverNone:matchMedia('(hover:none)').matches,hit:document.elementFromPoint(${point.x},${point.y})?.outerHTML,images:${stack}.querySelectorAll('img').length})`,
          )),
      );
      assert(
        await ev(`${stack}.querySelectorAll('img').length===3`),
        "expanded stack has no duplicate collapsed images",
      );
      assert(
        await ev(
          `getComputedStyle(${stack}.querySelector('section')).position==='static'`,
        ),
        "equipment expansion uses card layout",
      );
      await capture("equipment-stack");
      await c.cmd("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: width - 5,
        y: 100,
      });
      await pause(100);
      assert(
        await ev(`!${stack}.querySelector('section')`),
        "equipment stack retracts after hover leaves",
      );
    }
    await ev(
      `document.querySelector('[aria-label="pickup with Marcus Lee"]').click()`,
    );
    await pause(150);
    await capture("chat");
    if (width === 1505) {
      const handoffLayout = await ev(
        `(()=>{const rail=document.querySelector('[class*="handoffRail"]');return [...rail.querySelectorAll('button')].map(card=>{const name=card.querySelector('[class*="handoffRenter"]').getBoundingClientRect();const state=card.querySelector('[class*="pickup"],[class*="return"]').getBoundingClientRect();const r=card.getBoundingClientRect();return {height:r.height,overlap:name.left<state.right&&name.right>state.left&&name.top<state.bottom&&name.bottom>state.top};});})()`,
      );
      assert(
        handoffLayout.every((row) => row.height <= 100 && !row.overlap),
        "time-sensitive names and timing fit without overlapping",
      );
    }
    const chatSpace = await ev(
      `(()=>{const chat=document.querySelector('[aria-label="Conversation with Marcus Lee"]');const history=chat.querySelector('[class*="messages"]');const r=chat.getBoundingClientRect(),h=history.getBoundingClientRect();return {width:r.width,historyHeight:h.height};})()`,
    );
    assert(
      chatSpace.width >= (width === 390 ? 390 : 800),
      "open chat keeps a wide conversation",
    );
    assert(
      chatSpace.historyHeight >= (width === 390 ? 340 : 260),
      "message history keeps usable height",
    );

    if (width === 1505) {
      const heights = await ev(
        `[...document.querySelectorAll('[aria-label^="Open conversation with"]')].map(row=>row.getBoundingClientRect().height)`,
      );
      assert(
        Math.max(...heights) < 165,
        "medium queue rows retain compact reference density: " +
          JSON.stringify(heights),
      );
    }
    if (width === 1505) {
      const gear = await ev(
        `(()=>{const root=document.querySelector('[aria-label="Conversation with Marcus Lee"]');return [...root.querySelectorAll('[class*="chatGear"] section article>img')].map(img=>({width:img.getBoundingClientRect().width,height:img.getBoundingClientRect().height}));})()`,
      );
      assert.equal(
        gear.length,
        3,
        "full requested equipment remains visible in the reference gallery",
      );
      assert(
        gear.every(
          (img) =>
            Math.abs(img.height - 100) < 0.5 &&
            img.width >= 100 &&
            img.width <= 132.5,
        ),
        "reference gallery image geometry: " + JSON.stringify(gear),
      );
      assert(
        await ev(
          `(()=>{const btn=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='All');return btn.dataset.count===String(window.__fixture.rows.length)&&btn.getAttribute('aria-pressed')==='true';})()`,
        ),
        "view tab count and selected state are real queue data",
      );
    }
    const draftBefore = await ev(
      `window.__calls.filter(c=>c.name==='replyInbox_actions:generateDraft').length`,
    );
    await ev(
      `{window.__fixture.rows[0].preview='A new incoming message';window.__fixture.changed();}`,
    );
    await pause(100);
    assert.equal(
      await ev(
        `window.__calls.filter(c=>c.name==='replyInbox_actions:generateDraft').length`,
      ),
      draftBefore,
      "incoming updates do not auto draft",
    );
    assert(draftBefore > 0, "opening chat auto drafts");
    await ev(
      `[...document.querySelectorAll('button')].find(b=>b.offsetParent!==null&&b.textContent.trim().startsWith('Rental controls')).click()`,
    );
    await pause(200);
    if (width === 1505) {
      assert(
        await ev(
          `(()=>[...document.querySelector('[class*="handoffRail"]').querySelectorAll('button')].every(card=>{const identity=card.querySelector('[class*="handoffIdentity"]').getBoundingClientRect();const state=card.querySelector('[class*="pickup"],[class*="return"]').getBoundingClientRect();return !(identity.left<state.right&&identity.right>state.left&&identity.top<state.bottom&&identity.bottom>state.top);} ))()`,
        ),
        "narrow controls list keeps account identity clear of timing",
      );
    }
    await capture("controls");
    if (width === 1505) {
      const calendarSpace = await ev(
        `(()=>{const panel=document.querySelector('[aria-label="Rental controls"]');const cal=panel.querySelector('[class*="inlineCalendar"]');const last=[...cal.querySelectorAll('button')].find(b=>b.textContent.trim()==='31');return {lastDayBottom:last.getBoundingClientRect().bottom,footerTop:panel.querySelector('footer').getBoundingClientRect().top};})()`,
      );
      assert(
        calendarSpace.lastDayBottom < calendarSpace.footerTop,
        "whole month is visible above the booking navigation: " +
          JSON.stringify(calendarSpace),
      );
    }

    if (width === 1505)
      assert(
        await ev(
          `getComputedStyle(document.querySelector('[aria-label="Conversation with Marcus Lee"] [class*="chatGear"]')).display==='none'`,
        ),
        "controls keep one equipment summary in the side panel",
      );

    const geometry = await ev(
      `(()=>{const portrait=document.querySelector('[role=dialog] [aria-label="Expand profile image of Marcus Lee"]');const r=portrait.getBoundingClientRect();const panels=[document.querySelector('[aria-label="Rental controls"]'),document.querySelector('[data-conversation-content]')];return {portrait:{width:r.width,height:r.height},panels:panels.map(p=>{const r=p.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};}),horizontalOverflow:document.documentElement.scrollWidth-innerWidth,drafts:window.__calls.filter(c=>c.name==='replyInbox_actions:generateDraft').length};})()`,
    );
    assert(
      Math.abs(geometry.portrait.width - geometry.portrait.height) < 0.1,
      "portrait circular",
    );
    assert(geometry.horizontalOverflow <= 0, "no horizontal page overflow");
    if (width === 1505)
      assert(geometry.panels[1].width >= 600, "controls preserve wide chat");
    results.push({ width, chatSpace, ...geometry });
    await ev(
      `document.querySelector('[aria-label="Close conversation"]').click()`,
    );
    if (width === 1505) {
      assert(
        await ev(
          `!!document.querySelector('[aria-label="Request preview for Marcus Lee"]')`,
        ),
        "closing restores the previous request in the compact dock",
      );
      const count = await ev(
        `window.__calls.filter(c=>c.name==='replyInbox_actions:generateDraft').length`,
      );
      await ev(
        `document.querySelector('[aria-label="Open full chat with Marcus Lee"]').click()`,
      );
      await pause(100);
      assert.equal(
        await ev(
          `window.__calls.filter(c=>c.name==='replyInbox_actions:generateDraft').length`,
        ),
        count + 1,
        "preview button explicitly opens chat and drafts once",
      );
      await ev(
        `document.querySelector('[aria-label="Close conversation"]').click()`,
      );
    }
    await ev(
      `document.querySelector('[aria-label="Open conversation with Elena Rossi"] button').closest('[role=button]').querySelector('button').blur();[...document.querySelector('[aria-label="Open conversation with Elena Rossi"]').querySelectorAll('button')].find(b=>b.textContent.trim()==='Find replacement').click()`,
    );
    await pause(250);
    assert(
      await ev(
        `(()=>{const images=[...document.querySelector('[aria-label="Replacement options"]').querySelectorAll('img')];return images.length>=3&&images.every(img=>img.complete&&img.naturalWidth>0&&!img.src.includes('missing-replacement'));})()`,
      ),
      "original and complete-set replacement photos recover from failed primary URLs",
    );
    const replacementFrame = await ev(
      `(()=>{const panel=document.querySelector('[aria-label="Rental controls"]');const header=panel.querySelector('header').getBoundingClientRect();const close=document.querySelector('[aria-label="Close conversation"]').getBoundingClientRect();return {header:{top:header.top,bottom:header.bottom},close:{top:close.top,bottom:close.bottom},scrollY,viewport:innerHeight};})()`,
    );
    assert(
      replacementFrame.header.top >= 0 &&
        replacementFrame.close.top >= 0 &&
        replacementFrame.close.bottom <= replacementFrame.viewport,
      "replacement heading and single close stay onscreen: " +
        JSON.stringify(replacementFrame),
    );
    await capture("replacements");
    await c.closePage();
    c.close();
  }
  fs.writeFileSync(
    `${process.env.RM_QA_OUTPUT}/design-geometry.json`,
    JSON.stringify(results, null, 2),
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
