const { connect } = require("./browser.cjs"),
  assert = require("node:assert/strict"),
  fs = require("fs");
const root = process.env.RM_QA_OUTPUT;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const results = [];
  for (const width of [1192, 390]) {
    const c = await connect("about:blank"),
      errors = [];
    c.on((e) => {
      if (e.method === "Runtime.exceptionThrown")
        errors.push(e.params.exceptionDetails.text);
    });
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
    await c.cmd("Network.setCacheDisabled", { cacheDisabled: true });
    await c.cmd("Emulation.setDeviceMetricsOverride", {
      width,
      height: width === 390 ? 844 : 992,
      deviceScaleFactor: 1,
      mobile: width === 390,
    });
    await c.cmd("Emulation.setTouchEmulationEnabled", {
      enabled: width === 390,
    });
    await c.cmd("Page.navigate", { url: process.env.RM_QA_ORIGIN });
    await pause(400);
    const checks = [];
    const ev = (x) => c.evaluate(x);
    const ok = async (label, condition) => {
      const passed = await ev(condition);
      if (!passed) {
        fs.writeFileSync(root+`/failed-${width}.png`, Buffer.from((await c.cmd("Page.captureScreenshot", {captureBeyondViewport:false})).data, "base64"));
        console.error("Failed viewport", width, label);
      }
      assert(passed, label);
      checks.push(label);
    };
    async function tap(expr) {
      const rect = await ev(
        `(()=>{const e=${expr};if(!e)throw Error('Missing target: '+${JSON.stringify(expr)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`,
      );
      if (width === 390) {
        await c.cmd("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [rect],
        });
        await c.cmd("Input.dispatchTouchEvent", {
          type: "touchEnd",
          touchPoints: [],
        });
      } else {
        await c.cmd("Input.dispatchMouseEvent", {
          type: "mousePressed",
          ...rect,
          button: "left",
          clickCount: 1,
        });
        await c.cmd("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          ...rect,
          button: "left",
          clickCount: 1,
        });
      }
      await pause(80);
    }
    const button = (text) =>
      `[...([...document.querySelectorAll('[role=dialog]')].at(-1)??document).querySelectorAll('button')].find(e=>e.offsetParent!==null&&e.textContent.trim()===${JSON.stringify(text)})`;
    const contains = (text) =>
      `[...([...document.querySelectorAll('[role=dialog]')].at(-1)??document).querySelectorAll('button')].find(e=>e.offsetParent!==null&&e.textContent.includes(${JSON.stringify(text)}))`;
    const close = `document.querySelector('[aria-label="Close conversation"]')`,
      marcus = `document.querySelector('[aria-label="Open conversation with Marcus Lee"]')`;
    await ok("test toggle removed", `![...document.querySelectorAll('button')].some(e=>e.textContent.includes('Test mode'))`);
    await tap(button("Pending off"));
    await ok(
      "pending stock toggle",
      `window.__calls.some(c=>c.name==='settings:update'&&c.args.availability_include_pending===true)`,
    );
    for (const filter of ["Requests", "All", "To reply"]) {
      await tap(button(filter));
      checks.push("filter " + filter);
    }
    await ev(`{window.__fixture.rows[2].last_sender='owner';window.__fixture.changed();}`);
    await tap(button("To reply"));
    await ok("To reply excludes answered requests", `!document.querySelector('[aria-label="Open conversation with Daniel Kim"]')`);
    await tap(button("Requests"));
    await ok("Requests retains requests awaiting a decision", `!!document.querySelector('[aria-label="Open conversation with Daniel Kim"]')`);
    await ev(`{window.__fixture.rows[2].last_sender='renter';window.__fixture.rows[0].renter_image_url=null;window.__fixture.changed();}`);
    await tap(button("All"));
    await pause(150);
    await ok("missing portrait loads from provider read", `window.__calls.some(c=>c.name==='renter_trust:profilePhotos')&&document.querySelector('[aria-label="Open conversation with Marcus Lee"] img').src.endsWith('/face0.png')`);
    for (const sort of ["newest", "oldest", "waiting", "earnings", "priority"]) {
      await ev(
        `{const e=document.querySelector('[aria-label="Sort conversations"]');e.value='${sort}';e.dispatchEvent(new Event('change',{bubbles:true}));}`,
      );
      await pause(30);
      checks.push("sort " + sort);
      if(sort==='earnings') await ok("highest earnings is first", `document.querySelector('[aria-label^="Open conversation"]').getAttribute('aria-label')==='Open conversation with Marcus Lee'`);
    }
    await tap(contains("Quick texts"));
    await ok(
      "quick text manager opens",
      `document.querySelector('[aria-label="Close quick texts"]')!==null`,
    );
    await tap(`document.querySelector('[aria-label="Close quick texts"]')`);

    // Manage actual account-scoped quick text controls through the fixture mutation transport.
    await tap(contains("Quick texts"));
    await tap(button("Edit"));
    await ok(
      "quick text edit",
      `document.body.textContent.includes('Edit quick text')`,
    );
    await tap(button("Cancel"));
    await tap(button("Edit"));
    await tap(button("Save"));
    await ok(
      "quick text update saved",
      `window.__calls.some(c=>c.name==='canned_responses:update')`,
    );
    async function input(selector, value) {
      await ev(
        `{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));}`,
      );
      await pause(30);
    }
    await input(
      'input[placeholder="Label (e.g. Bank details)"]',
      "Fixture new preset",
    );
    await input(
      'textarea[placeholder="Text to paste into Quick Reply (delivery, location, bank info…)"]',
      "Fixture-only newly saved text",
    );
    await tap(button("Add"));
    await ok(
      "quick text create",
      `window.__calls.some(c=>c.name==='canned_responses:create')`,
    );
    await ev("window.confirm=()=>true");
    await tap(
      `[...document.querySelectorAll('button')].filter(e=>e.offsetParent!==null&&e.textContent.trim()==='Delete').at(-1)`,
    );
    await ok(
      "quick text delete",
      `window.__calls.some(c=>c.name==='canned_responses:remove')`,
    );
    await tap(`document.querySelector('[aria-label="Close quick texts"]')`);
    await tap(marcus);
    await ok(
      "conversation opens",
      `document.querySelector('[role=dialog]')!==null`,
    );
    if(width===1192) await ok("chat expands to half the workspace",`(()=>{const dock=document.querySelector('[role=dialog]').parentElement,r=dock.getBoundingClientRect(),split=dock.parentElement.getBoundingClientRect();return Math.abs(r.width-(split.width-10)/2)<2})()`);
    await ok(
      "composer visible without opening drawer",
      `document.querySelector('textarea[placeholder="Write a reply…"]').offsetParent!==null`,
    );
    await ok(
      "AI pill above typing pill",
      `(()=>{const ai=document.querySelector('[title="Draft a reply from this conversation"]'),input=document.querySelector('textarea[placeholder="Write a reply…"]');return ai.getBoundingClientRect().bottom<=input.parentElement.getBoundingClientRect().top&&parseFloat(getComputedStyle(ai).borderRadius)>=20&&parseFloat(getComputedStyle(input.parentElement).borderRadius)>=30})()`,
    );
    await ok(
      "all three shortcuts above composer",
      `['Location','Times','Delivery info'].every(label=>[...document.querySelector('[aria-label="Reply shortcuts"]').querySelectorAll('button')].some(b=>b.textContent.trim()===label&&b.offsetParent!==null))`,
    );

    await tap(`document.querySelector('[title="View all renter reviews"]')`);
    await ok(
      "reviews open",
      `document.body.textContent.includes('Great renter.')`,
    );
    await tap(close);
    await ok("close from reviews", `!document.querySelector('[role=dialog]')`);
    await tap(marcus);
    await tap(
      `document.querySelector('[aria-label="Write reply or insert text file"]')`,
    );
    await ok(
      "composer opens",
      `document.querySelector('textarea[placeholder="Write a reply…"]').offsetParent!==null`,
    );
    await c.cmd("Page.setInterceptFileChooserDialog", { enabled: true });
    await tap(button("Insert text file"));
    const filePath = root + "/fixture-reply.txt";
    fs.writeFileSync(filePath, "Fixture text-file reply.");
    const doc = await c.cmd("DOM.getDocument");
    const fileInput = await c.cmd("DOM.querySelector", {
      nodeId: doc.root.nodeId,
      selector: "input[type=file]",
    });
    await c.cmd("DOM.setFileInputFiles", {
      nodeId: fileInput.nodeId,
      files: [filePath],
    });
    await pause(100);
    await ok(
      "text file inserts into reply without sending",
      `document.querySelector('textarea[placeholder="Write a reply…"]').value.includes('Fixture text-file reply.')&&!window.__calls.some(c=>c.name==='replyInbox_actions:sendRenterReply')`,
    );
    for (const label of ["Location", "Times", "Delivery info"]) {
      await tap(contains(label));
      checks.push("snippet " + label);
    }
    await ok(
      "snippets insert",
      `document.querySelector('textarea[placeholder="Write a reply…"]').value.includes('Fixture studio')`,
    );
    await tap(
      `document.querySelector('[title="Customize these quick replies for this account"]')`,
    );
    await ok(
      "account editor opens",
      `document.querySelector('[aria-label="Close quick reply editor"]')!==null`,
    );
    for (const slot of ["Times", "Delivery"]) {
      await tap(button(slot));
      checks.push("customize tab " + slot);
    }
    await ev(
      `{const e=[...document.querySelectorAll('textarea')].find(e=>e.placeholder==='Write account-specific text…');const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;set.call(e,'Fixture custom delivery text');e.dispatchEvent(new Event('input',{bubbles:true}));}`,
    );
    await pause(40);
    await tap(button("Save & insert"));
    await ok(
      "save account snippet",
      `window.__calls.some(c=>c.name==='canned_responses:update')`,
    );
    await tap(
      `document.querySelector('[aria-label="Collapse reply composer"]')`,
    );
    await tap(contains("Draft reply"));
    await ok(
      "context AI draft action",
      `window.__calls.some(c=>c.name==='replyInbox_actions:generateDraft')`,
    );
    await tap(close);
    await ok(
      "close with AI composer open",
      `!document.querySelector('[role=dialog]')`,
    );
    await tap(marcus);
    await tap(button("Send"));
    await ok(
      "empty send opens composer",
      `document.querySelector('textarea[placeholder="Write a reply…"]').offsetParent!==null`,
    );
    await ev(
      `{const e=document.querySelector('textarea[placeholder="Write a reply…"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'Fixture unsent test reply');e.dispatchEvent(new Event('input',{bubbles:true}));}`,
    );
    await pause(30);
    await tap(button("Send"));
    await ok(
      "manual send reaches native provider transport",
      `window.__calls.some(c=>c.name==='replyInbox_actions:sendRenterReply'&&c.args.dryRun===false)`,
    );
    await tap(close);

    await tap(marcus);
    async function openBooking(action) {
      if (!await ev(`!!document.querySelector('[aria-label="Rental controls"]')`)) await tap(contains("Rental controls"));
      await tap(button(action));
      await pause(100);
    }
    await tap(`document.querySelector('[aria-label="Open rental controls"]')`);
    for (const tab of ["Dates", "Pricing", "Gear"]) {
      await tap(`[...document.querySelectorAll('[role=tab]')].find(e=>e.textContent==='${tab}')`);
      await ok("rental tab " + tab, `[...document.querySelectorAll('[role=tab]')].find(e=>e.textContent==='${tab}').getAttribute('aria-selected')==='true'`);
    }
    await tap(`document.querySelector('[aria-label="Close rental controls"]')`);
    await ok("drawer close keeps conversation", `!!document.querySelector('[role=dialog]')&&!document.querySelector('[aria-label="Rental controls"]')`);
    await openBooking("Change rental");
    await ok(
      "booking editor loads",
      `document.querySelector('[aria-label="Close booking editor"]')!==null`,
    );
    await tap(`document.querySelector('[title="Refresh from Hygglo"]')`);
    checks.push("refresh booking");
    await tap(button("Remove"));
    await tap(button("Remove"));
    await ok(
      "remove item dry run",
      `window.__calls.some(c=>c.name==='order_edit:removeItem'&&c.args.dryRun===false)`,
    );
    await tap(contains("Add item"));
    await tap(button("Add"));
    await ok(
      "add item dry run",
      `window.__calls.some(c=>c.name==='order_edit:addItem'&&c.args.dryRun===false)`,
    );
    await tap(
      `document.querySelector('[title="Change the price (discount or increase)"]')`,
    );
    for (const delta of ["-10", "-5", "+5"]) {
      await tap(button(delta));
      checks.push("price delta " + delta);
    }
    await tap(button("Apply price"));
    await ok(
      "discount apply dry run",
      `window.__calls.some(c=>c.name==='order_edit:setPrice'&&c.args.dryRun===false)`,
    );
    await tap(button("Refund…"));
    await ev(
      `{const e=document.querySelector('input[placeholder="0.00"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'10');e.dispatchEvent(new Event('input',{bubbles:true}));}`,
    );
    await pause(30);
    await tap(contains("Refund £"));
    await ok(
      "refund dry run",
      `window.__calls.some(c=>c.name==='order_edit:refund'&&c.args.dryRun===false)`,
    );
    await tap(`document.querySelector('[title="Change the rental dates"]')`);
    await tap(button("›"));
    await tap(button("‹"));
    await tap(button("20"));
    await tap(button("22"));
    await tap(button("Apply dates"));
    await ok(
      "reschedule dry run",
      `window.__calls.some(c=>c.name==='order_edit:setDates'&&c.args.dryRun===false)`,
    );
    await tap(`document.querySelector('[aria-label="Close booking editor"]')`);
    checks.push("close booking editor");
    if (width !== 390) {
      for (const action of ["Reschedule", "Discount", "Refund"]) {
        await tap(contains("Rental controls"));
        await tap(button(action));
        await ok(
          "dropdown " + action,
          `document.querySelector('[aria-label="Close booking editor"]')!==null`,
        );
        await tap(close);
        await ok(
          "close conversation with " + action + " panel",
          `!document.querySelector('[role=dialog]')`,
        );
        await tap(marcus);
      }
    }
    await tap(close);
    // The list button opens a prepared proposal, with no booking or message write.
    await ev(`{window.__fixture.rows[3].can_accept=true;window.__fixture.changed();}`);
    await ok("unavailable row has no approve", `![...document.querySelector('[aria-label="Open conversation with Elena Rossi"]').querySelectorAll('button')].some(b=>b.textContent.trim()==='Approve')`);
    await tap(`[...document.querySelector('[aria-label="Open conversation with Elena Rossi"]').querySelectorAll('button')].find(b=>b.textContent.trim()==='Find replacement')`);
    await ok("two available alternatives", `document.body.textContent.includes('Sony FX3 replacement')&&document.body.textContent.includes('Canon C70 replacement')`);
    await ok(
      "replacement card and AI draft",
      `document.body.textContent.includes('Sony FX3 replacement')&&document.querySelector('textarea[placeholder="Writing a reply from this conversation…"]').value.includes('So sorry')`,
    );
    await tap(`[...document.querySelectorAll('[aria-label="Replacement options"] button')].find(b=>b.textContent.includes('Canon C70 replacement'))`);
    await ok("second replacement selects and prepares a draft", `document.querySelector('[aria-label="Replacement options"] button[aria-pressed=true]').textContent.includes('Canon C70 replacement')&&window.__calls.some(c=>c.name==='quick_reply_replacements:draft'&&c.args.replacement_id==='34')`);
    await tap(button("Review message in chat"));
    await ok(
      "replacement draft inserted",
      `document.querySelector('textarea[placeholder="Write a reply…"]').value.includes('So sorry')`,
    );
    await tap(contains("Find replacement"));
    const sendsBeforeReplacement = await ev(`window.__calls.filter(c=>/sendRenterReply|sendOwnerReply/.test(c.name)).length`);
    await tap(button("✓ Approve replacement"));
    await ok("replacement approval never sends a message", `window.__calls.filter(c=>/sendRenterReply|sendOwnerReply/.test(c.name)).length===${sendsBeforeReplacement}`);
    await ok("replacement cannot be applied twice", `[...document.querySelectorAll('button')].find(b=>b.textContent==='✓ Replacement approved').disabled`);
    await tap(button("➤ Send message"));
    await ok("replacement message sends only on separate explicit action", `window.__calls.filter(c=>/sendRenterReply|sendOwnerReply/.test(c.name)).length===${sendsBeforeReplacement+1}`);

    await ok(
      "replacement accept uses actual operator arguments",
      `window.__calls.some(c=>c.name==='quick_reply_replacements:accept'&&c.args.dryRun===false)`,
    );
    await tap(close);

    // Approval and decline remain deliberate, separately confirmed actions.
    await ev(
      `{Object.assign(window.__fixture.rows[0],{can_accept:true,can_deny:true,booking_status:null,status:'pending',order_step:'REQUEST'});window.__fixture.changed();}`,
    );
    for (const decision of ["Approve", "Decline"]) {
      await tap(marcus);
      await tap(
        `document.querySelector('[aria-label="Write reply or insert text file"]')`,
      );
      await tap(button(decision));
      await tap(button("Cancel"));
      checks.push(decision + " cancel");
      await tap(button(decision));
      await tap(button("Confirm"));
      await ok(
        decision + " dry run",
        `window.__calls.some(c=>c.name==='replyInbox_actions:${decision === "Approve" ? "approveOrder" : "declineOrder"}')`,
      );
      await tap(close);
    }
    // DB Cinema conversation: draft/copy/send all use its own bridge.
    await tap(
      `document.querySelector('[aria-label="Open conversation with Priya Sharma"]')`,
    );
    await tap(
      `document.querySelector('[title="Customize these quick replies for this account"]')`,
    );
    await ok(
      "website snippets are separate from Hygglo",
      `document.querySelector('textarea[placeholder="Write account-specific text…"]').value===''`,
    );
    await ev(
      `{const e=document.querySelector('textarea[placeholder="Write account-specific text…"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'Website-only location fixture');e.dispatchEvent(new Event('input',{bubbles:true}));}`,
    );
    await pause(30);
    await tap(button("Save & insert"));
    await ok(
      "website snippet saved to website account",
      `window.__calls.some(c=>c.name==='canned_responses:create'&&c.args.account_slug==='dbcinema_web'&&c.args.text==='Website-only location fixture')`,
    );
    await tap(contains("Draft reply"));
    await ok(
      "DB Cinema contextual draft",
      `window.__calls.some(c=>c.name==='dbcinema_chat:draftReply')`,
    );
    const texts = await ev(
      `[...document.querySelectorAll('button')].filter(e=>e.offsetParent!==null).map(e=>e.textContent.trim())`,
    );
    fs.writeFileSync(
      root + "/db-buttons-" + width + ".json",
      JSON.stringify(texts, null, 2),
    );
    await tap(button("Fixture DB Cinema contextual reply."));
    await ok(
      "DB Cinema draft copies",
      `document.querySelector('textarea[placeholder="Write a reply…"]').value.includes('Fixture DB Cinema contextual reply.')`,
    );
    await tap(button("Send"));
    await ok(
      "DB Cinema send reaches website transport",
      `window.__calls.some(c=>c.name==='dbcinema_chat:sendOwnerReply')`,
    );
    await ev(
      `{window.__fixture.rows[1].booking_status='confirmed';window.__fixture.rows[1].paid=true;window.__fixture.rows[1].verification_started=true;window.__fixture.rows[1].platform_booking_confirmed=false;document.dispatchEvent(new Event('visibilitychange'));}`,
    );
    await pause(150);
    await ok(
      "live website pending stage",
      `document.querySelector('[role=dialog] [aria-label="Booking progress: Pending"]')!==null`,
    );
    await ev(
      `{window.__fixture.rows[1].booking_status='confirmed';window.__fixture.rows[1].platform_booking_confirmed=true;document.dispatchEvent(new Event('visibilitychange'));}`,
    );
    await pause(150);
    await ok(
      "live website confirmed stage",
      `document.querySelector('[role=dialog] [aria-label="Booking progress: Confirmed"]')!==null`,
    );
    await ev(`{window.__fixture.rows[1].availability.status='conflict';window.__fixture.rows[1].availability.items=[{name:window.__fixture.rows[1].items[0].name,available:false,requested:1,total_units:1,free:0,booked:1,pending:0}];document.dispatchEvent(new Event('visibilitychange'));}`);
    await pause(150);
    await tap(contains("Find replacement"));
    await ok("website replacement reads its booking", `window.__calls.some(c=>c.name==='dbcinema_chat:replacementOptions'&&c.args.booking_id)`);
    const websiteSendCount = await ev(`window.__calls.filter(c=>c.name==='dbcinema_chat:sendOwnerReply').length`);
    await tap(button("✓ Approve replacement"));
    await ok("website replacement approval uses website guarded action", `window.__calls.some(c=>c.name==='dbcinema_chat:acceptReplacement'&&c.args.booking_id&&c.args.dryRun===false)`);
    await ok("website replacement approval does not send", `window.__calls.filter(c=>c.name==='dbcinema_chat:sendOwnerReply').length===${websiteSendCount}`);
    await tap(button("➤ Send message"));
    await ok("website replacement separate send reaches website chat", `window.__calls.filter(c=>c.name==='dbcinema_chat:sendOwnerReply').length===${websiteSendCount+1}`);
    await tap(`document.querySelector('[aria-label="Open rental controls"]')`);
    await tap(button("Refund"));
    await ok("website refund opens exact source review", `document.querySelector('[aria-label="Rental controls"] a').href.includes('action=refund')&&document.querySelector('[aria-label="Rental controls"] a').href.includes('rental=')`);
    await tap(close);
    for (let i = 0; i < 10; i++) {
      await tap(marcus);
      await tap(close);
      await ok(
        "repeated real pointer close " + i,
        `!document.querySelector('[role=dialog]')`,
      );
    }
    await ok(
      "no horizontal overflow",
      `document.documentElement.scrollWidth<=innerWidth`,
    );
    assert.deepEqual(errors, []);
    const calls = await ev("window.__calls");
    assert(
      calls
        .filter((x) =>
          /sendRenterReply|sendOwnerReply|acceptReplacement|quick_reply_replacements:accept/.test(
            x.name,
          ),
        )
        .every((x) => x.args.dryRun !== true),
      "business operations use normal arguments through isolated fixture transport",
    );
    results.push({ width, checks, calls, errors });
    await c.closePage();
    c.close();
  }
  fs.writeFileSync(
    root + "/individual-controls.json",
    JSON.stringify(results, null, 2),
  );
  console.log(
    results.map((r) => ({
      width: r.width,
      passed: r.checks.length,
      errors: r.errors,
    })),
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
