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
      assert(await ev(condition), label);
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
    await tap(button("Test mode"));
    await ok(
      "test mode enabled",
      `document.querySelector('button[aria-pressed=true]')!==null`,
    );
    await tap(button("Pending off"));
    await ok(
      "pending stock toggle",
      `window.__calls.some(c=>c.name==='settings:update'&&c.args.availability_include_pending===true)`,
    );
    for (const filter of ["Requests", "All", "To reply"]) {
      await tap(button(filter));
      checks.push("filter " + filter);
    }
    for (const sort of ["newest", "oldest", "waiting"]) {
      await ev(
        `{const e=document.querySelector('[aria-label="Sort conversations"]');e.value='${sort}';e.dispatchEvent(new Event('change',{bubbles:true}));}`,
      );
      await pause(30);
      checks.push("sort " + sort);
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
      "send stays in test mode",
      `window.__calls.some(c=>c.name==='replyInbox_actions:sendRenterReply'&&c.args.dryRun===true)`,
    );
    await tap(close);

    await tap(marcus);
    async function openBooking(action) {
      if (width === 390) {
        await tap(
          `document.querySelector('[aria-label="Write reply or insert text file"]')`,
        );
        await tap(contains("Booking actions"));
      } else {
        await tap(`document.querySelector('summary')`);
        await tap(button(action));
      }
      await pause(100);
    }
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
      `window.__calls.some(c=>c.name==='order_edit:removeItem'&&c.args.dryRun===true)`,
    );
    await tap(contains("Add item"));
    await tap(button("Add"));
    await ok(
      "add item dry run",
      `window.__calls.some(c=>c.name==='order_edit:addItem'&&c.args.dryRun===true)`,
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
      `window.__calls.some(c=>c.name==='order_edit:setPrice'&&c.args.dryRun===true)`,
    );
    await tap(button("Refund…"));
    await ev(
      `{const e=document.querySelector('input[placeholder="0.00"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'10');e.dispatchEvent(new Event('input',{bubbles:true}));}`,
    );
    await pause(30);
    await tap(contains("Refund £"));
    await ok(
      "refund dry run",
      `window.__calls.some(c=>c.name==='order_edit:refund'&&c.args.dryRun===true)`,
    );
    await tap(`document.querySelector('[title="Change the rental dates"]')`);
    await tap(button("›"));
    await tap(button("‹"));
    await tap(button("20"));
    await tap(button("22"));
    await tap(button("Apply dates"));
    await ok(
      "reschedule dry run",
      `window.__calls.some(c=>c.name==='order_edit:setDates'&&c.args.dryRun===true)`,
    );
    await tap(`document.querySelector('[aria-label="Close booking editor"]')`);
    checks.push("close booking editor");
    if (width !== 390) {
      for (const action of ["Reschedule", "Discount", "Refund"]) {
        await tap(`document.querySelector('summary')`);
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
    // Safe replacement preview/use/accept controls use only the intercepted fixture transport.
    await tap(
      `document.querySelector('[aria-label="Open conversation with Elena Rossi"]')`,
    );
    await tap(contains("Find replacement"));
    await ok(
      "replacement card and AI draft",
      `document.body.textContent.includes('Sony FX3 replacement')&&document.querySelector('textarea[placeholder="Writing a reply from this conversation…"]').value.includes('So sorry')`,
    );
    await tap(button("Use reply"));
    await ok(
      "replacement draft inserted",
      `document.querySelector('textarea[placeholder="Write a reply…"]').value.includes('So sorry')`,
    );
    await tap(contains("Find replacement"));
    await tap(button("Check replacement"));
    await ok(
      "replacement accept is dry run",
      `window.__calls.some(c=>c.name==='quick_reply_replacements:accept'&&c.args.dryRun===true)`,
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
      "DB Cinema send is dry run",
      `!window.__calls.some(c=>c.name==='dbcinema_chat:sendOwnerReply')&&document.body.textContent.includes('test')`,
    );
    await ev(
      `{window.__fixture.rows[1].booking_status='pending_payment';document.dispatchEvent(new Event('visibilitychange'));}`,
    );
    await pause(150);
    await ok(
      "live website pending stage",
      `document.querySelector('[role=dialog] [aria-label="Booking progress: Pending"]')!==null`,
    );
    await ev(
      `{window.__fixture.rows[1].booking_status='confirmed';document.dispatchEvent(new Event('visibilitychange'));}`,
    );
    await pause(150);
    await ok(
      "live website confirmed stage",
      `document.querySelector('[role=dialog] [aria-label="Booking progress: Confirmed"]')!==null`,
    );
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
        .every((x) => x.args.dryRun === true),
      "business operations must be fixtures with dryRun",
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
