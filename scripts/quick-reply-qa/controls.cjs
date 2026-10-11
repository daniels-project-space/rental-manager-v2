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
        fs.writeFileSync(
          root + `/failed-${width}.png`,
          Buffer.from(
            (
              await c.cmd("Page.captureScreenshot", {
                captureBeyondViewport: false,
              })
            ).data,
            "base64",
          ),
        );
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
    await ok(
      "test toggle removed",
      `![...document.querySelectorAll('button')].some(e=>e.textContent.includes('Test mode'))`,
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
    await ev(
      `{window.__fixture.rows[2].last_sender='owner';window.__fixture.changed();}`,
    );
    await tap(button("To reply"));
    await ok(
      "To reply excludes answered requests",
      `!document.querySelector('[aria-label="Open conversation with Daniel Kim"]')`,
    );
    await tap(button("Requests"));
    await ok(
      "Requests retains requests awaiting a decision",
      `!!document.querySelector('[aria-label="Open conversation with Daniel Kim"]')`,
    );
    await ev(
      `{window.__fixture.rows[2].last_sender='renter';window.__fixture.rows[0].renter_image_url=null;window.__fixture.changed();}`,
    );
    await tap(button("All"));
    await pause(150);
    await ok(
      "missing portrait loads from provider read",
      `window.__calls.some(c=>c.name==='renter_trust:profilePhotos')&&document.querySelector('[aria-label="Open conversation with Marcus Lee"] img').src.endsWith('/face0.png')`,
    );
    if (width === 1192) {
      // Headless Chrome advertises no physical pointer; model a real desktop.
      await ev(
        `{const original=window.matchMedia.bind(window);window.matchMedia=query=>query==='(hover: none)'?{matches:false}:original(query);}`,
      );
      const avatar = await ev(
        `(()=>{const el=document.querySelector('[aria-label="Expand profile image of Marcus Lee"]'),r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`,
      );
      await c.cmd("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        ...avatar,
      });
      await pause(100);
      await ok(
        "profile hover keeps one preview and no legacy zoom",
        `document.querySelectorAll('[data-profile-preview]').length===1&&getComputedStyle(document.querySelector('[aria-label="Expand profile image of Marcus Lee"] img')).transform==='none'`,
      );
      await c.cmd("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: 5,
        y: 5,
      });
    }
    await tap(
      `document.querySelector('[aria-label="Open conversation with Marcus Lee"] [aria-label="Expand profile image of Marcus Lee"]')`,
    );
    await ok(
      "list photo opens without opening conversation",
      `!!document.querySelector('[aria-label="Close profile image"]')&&!document.querySelector('[aria-label="Close conversation"]')`,
    );
    await tap(`document.querySelector('[aria-label="Close profile image"]')`);
    await ok(
      "list photo close never opens conversation",
      `!document.querySelector('[role=dialog]')`,
    );
    for (const sort of [
      "newest",
      "oldest",
      "waiting",
      "earnings",
      "priority",
    ]) {
      await ev(
        `{const e=document.querySelector('[aria-label="Sort conversations"]');e.value='${sort}';e.dispatchEvent(new Event('change',{bubbles:true}));}`,
      );
      await pause(30);
      checks.push("sort " + sort);
      if (sort === "earnings")
        await ok(
          "highest earnings is first",
          `document.querySelector('[aria-label^="Open conversation"]').getAttribute('aria-label')==='Open conversation with Marcus Lee'`,
        );
    }
    await ev(
      `{window.__originalStock=structuredClone(window.__fixture.rows[0]);const row=window.__fixture.rows[0];row.items=Array.from({length:8},(_,i)=>({name:'Stock fixture '+i,qty:1,image_url:null}));row.item_count=8;row.availability={status:'unknown',checked_at:Date.now(),include_pending:false,items:row.items.map((item,i)=>({item_index:i,name:item.name,requested:1,total_units:1,booked:0,pending:0,free:1,available:i===7?null:true,...(i===7?{reason:'Gear needs an inventory mapping'}:{})}))};window.__fixture.changed();}`,
    );
    await pause(100);
    await tap(
      `[...document.querySelectorAll('[aria-label="Open conversation with Marcus Lee"]')].find(e=>e.textContent.includes("Stock fixture 0")).querySelector('[aria-label^="Show stock"]')`,
    );
    await ok(
      "all eight requested items show their own stock result",
      `(()=>{const row=[...document.querySelectorAll('[aria-label="Open conversation with Marcus Lee"]')].find(e=>e.textContent.includes("Stock fixture 0"));return row.textContent.includes('Stock fixture 7')&&row.textContent.includes('Gear needs an inventory mapping')&&row.querySelector('[aria-label^="Show stock"]').getAttribute("aria-expanded")==="true"})()`,
    );
    fs.writeFileSync(
      root + `/item-stock-${width}.png`,
      Buffer.from(
        (
          await c.cmd("Page.captureScreenshot", {
            captureBeyondViewport: false,
          })
        ).data,
        "base64",
      ),
    );
    await ev(
      `{window.__fixture.rows[0]=window.__originalStock;window.__fixture.changed();}`,
    );
    await ev(
      `{window.__savedRequest=structuredClone(window.__fixture.rows[0]);const row=window.__fixture.rows[0];row.requested_items=[...row.items.map(i=>({...i,origin:'basket'})),{name:'Sigma 24-70 from chat',qty:1,image_url:'/gear1.png',origin:'chat'},{name:'Aputure from basket',qty:2,image_url:'/gear2.png',origin:'basket'}];window.__fixture.changed();}`,
    );
    await pause(100);
    const stack = `document.querySelector('[aria-label="Open conversation with Marcus Lee"] [aria-label="Show all 3 requested items"]')`;
    if (width === 1192) {
      const r = await ev(
        `(()=>{const r=${stack}.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`,
      );
      await c.cmd("Input.dispatchMouseEvent", { type: "mouseMoved", ...r });
      await pause(100);
      await ok(
        "equipment stack expands on hover",
        `!!document.querySelector('[aria-label="All requested items"]')`,
      );
      await c.cmd("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: 5,
        y: 5,
      });
    }
    await tap(stack);
    await ok(
      "stack shows all basket and chat images without opening chat",
      `document.querySelector('[aria-label="All requested items"]')?.querySelectorAll('article').length===3&&document.querySelector('[aria-label="All requested items"]').querySelectorAll('article img').length===3&&document.body.textContent.includes('Mentioned in chat')&&!document.querySelector('[aria-label="Close conversation"]')`,
    );
    fs.writeFileSync(
      root + `/requested-stack-${width}.png`,
      Buffer.from(
        (
          await c.cmd("Page.captureScreenshot", {
            captureBeyondViewport: false,
          })
        ).data,
        "base64",
      ),
    );
    await tap(
      `document.querySelector('[aria-label="Collapse requested items"]')`,
    );
    if (width !== 390) {
      await c.cmd("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: 5,
        y: 5,
      });
      await pause(100);
    }
    await ok(
      "closing equipment stack preserves list",
      `!document.querySelector('[aria-label="All requested items"]')&&!document.querySelector('[aria-label="Close conversation"]')`,
    );
    await ev(
      `{window.__fixture.rows[0]=window.__savedRequest;window.__fixture.changed();}`,
    );
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
    if (width === 1192)
      await ok(
        "chat expands to sixty percent of the workspace",
        `(()=>{const dock=document.querySelector('[role=dialog]').parentElement,r=dock.getBoundingClientRect(),split=dock.parentElement.getBoundingClientRect();return Math.abs(r.width-(split.width-12)*0.6)<2})()`,
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

    await tap(
      `document.querySelector('[role=dialog] [aria-label="Expand profile image of Marcus Lee"]')`,
    );
    await ok(
      "profile photo expands outside chat frame",
      `(()=>{const photo=document.querySelector('[aria-label="Profile image of Marcus Lee"]');return photo?.parentElement===document.body&&getComputedStyle(photo).position==='fixed'&&photo.querySelector('img').getBoundingClientRect().width>100})()`,
    );
    await ok(
      "photo close receives focus",
      `document.activeElement?.getAttribute('aria-label')==='Close profile image'`,
    );
    await c.cmd("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Tab",
      code: "Tab",
      windowsVirtualKeyCode: 9,
    });
    await c.cmd("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Tab",
      code: "Tab",
      windowsVirtualKeyCode: 9,
    });
    await ok(
      "photo keyboard focus stays in viewer",
      `document.activeElement?.getAttribute('aria-label')==='Close profile image'`,
    );
    fs.writeFileSync(
      root + `/expanded-profile-${width}.png`,
      Buffer.from(
        (
          await c.cmd("Page.captureScreenshot", {
            captureBeyondViewport: false,
          })
        ).data,
        "base64",
      ),
    );
    await tap(`document.querySelector('[aria-label="Close profile image"]')`);
    await ok(
      "photo close preserves conversation",
      `!document.querySelector('[aria-label="Profile image of Marcus Lee"]')&&!!document.querySelector('[aria-label="Close conversation"]')`,
    );
    await tap(`document.querySelector('[title="View all renter reviews"]')`);
    await ok(
      "reviews open",
      `document.body.textContent.includes('Great renter.')`,
    );
    await ok(
      "review dates preserve exact and relative labels",
      `document.body.textContent.includes("1 May 2026")&&document.body.textContent.includes("2 weeks ago")&&!document.body.textContent.includes("Invalid Date")`,
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
      if (
        !(await ev(
          `!!document.querySelector('[aria-label="Rental controls"]')`,
        ))
      )
        await tap(contains("Rental controls"));
      await tap(button(action));
      await pause(100);
    }
    await tap(contains("Rental controls"));
    await ok(
      "all settings visible in one vertical list",
      `[...document.querySelector('[aria-label="Rental controls"]').querySelectorAll('h4')].map(e=>e.textContent).join('|').includes('1. Equipment|2. Rental dates|3. Pricing')&&!document.querySelector('[role=tab]')`,
    );
    await tap(`document.querySelector('[aria-label="Back to chat"]')`);
    await ok(
      "controls back keeps conversation",
      `!!document.querySelector('[aria-label="Close conversation"]')&&!document.querySelector('[aria-label="Rental controls"]')`,
    );
    await openBooking("Change rental");
    await ok(
      "booking editor loads",
      `document.querySelector('[aria-label="Rental controls"]')!==null`,
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
    await tap(`document.querySelector('[aria-label="Back to chat"]')`);
    checks.push("close booking editor");
    if (width !== 390) {
      for (const action of ["Reschedule", "Discount", "Refund"]) {
        await tap(contains("Rental controls"));
        await tap(button(action));
        await ok(
          "dropdown " + action,
          `document.querySelector('[aria-label="Rental controls"]')!==null`,
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
    await ev(
      `{window.__fixture.rows[3].can_accept=true;window.__fixture.changed();}`,
    );
    await ok(
      "unavailable row has no approve",
      `![...document.querySelector('[aria-label="Open conversation with Elena Rossi"]').querySelectorAll('button')].some(b=>b.textContent.trim()==='Approve')`,
    );
    await ev(
      `{window.__originalReplacement=structuredClone(window.__fixture.rows[3]);const row=window.__fixture.rows[3];row.items.push({name:'Available tripod',qty:1,image_url:'/gear2.png'},{name:'Unavailable lens',qty:1,image_url:'/gear1.png'});row.availability.items.push({item_index:1,name:'Available tripod',available:true},{item_index:2,name:'Unavailable lens',available:false});window.__fixture.changed();}`,
    );
    await tap(
      `[...document.querySelector('[aria-label="Open conversation with Elena Rossi"]').querySelectorAll('button')].find(b=>b.textContent.trim()==='Find replacement')`,
    );
    await ok(
      "replacement covers all unavailable lines at once",
      `!document.querySelector('[aria-label="Requested replacement item"]')&&document.querySelector('[aria-label="Replacement options"]').textContent.includes('Unavailable lens')&&window.__calls.some(c=>c.name==='quick_reply_replacements:basketOptions'&&!('item_index' in c.args))`,
    );

    await ok(
      "replacement picker contains no rental settings",
      `!document.querySelector('[aria-label="Replacement options"]').closest('aside').querySelector('[aria-label="Rental settings"]')&&!document.querySelector('[aria-label="Replacement options"]').closest('aside').textContent.includes('Booking actions')`,
    );
    fs.writeFileSync(
      root + `/replacement-picker-${width}.png`,
      Buffer.from(
        (
          await c.cmd("Page.captureScreenshot", {
            captureBeyondViewport: false,
          })
        ).data,
        "base64",
      ),
    );
    await ok(
      "two available alternatives",
      `document.body.textContent.includes('Sony FX3 replacement')&&document.body.textContent.includes('Canon C70 replacement')`,
    );
    await ok(
      "replacement card and AI draft",
      `document.body.textContent.includes('Sony FX3 replacement')&&document.querySelector('textarea[placeholder="Writing a reply from this conversation…"]').value.includes('So sorry')`,
    );
    await tap(
      `[...document.querySelectorAll('[aria-label="Replacement options"] button')].find(b=>b.textContent.includes('Canon C70 replacement'))`,
    );
    await ok(
      "second replacement selects and prepares a draft",
      `document.querySelector('[aria-label="Replacement options"] button[aria-pressed=true]').textContent.includes('Canon C70 replacement')&&window.__calls.some(c=>c.name==='quick_reply_replacements:draft'&&c.args.replacement_id==='34'&&c.args.basket===true)`,
    );
    await tap(button("Edit in chat ↗"));
    await ok(
      "replacement draft inserted",
      `document.querySelector('textarea[placeholder="Write a reply…"]').value.includes('So sorry')`,
    );
    await tap(contains("Find replacement"));
    const sendsBeforeReplacement = await ev(
      `window.__calls.filter(c=>/sendRenterReply|sendOwnerReply/.test(c.name)).length`,
    );
    await tap(button("Use complete set in booking"));
    await ok(
      "replacement approval never sends a message",
      `window.__calls.filter(c=>/sendRenterReply|sendOwnerReply/.test(c.name)).length===${sendsBeforeReplacement}`,
    );
    await ok(
      "replacement cannot be applied twice",
      `[...document.querySelectorAll('button')].find(b=>b.textContent==='✓ Booking updated').disabled`,
    );
    await tap(button("Send replacement offer"));
    await ok(
      "replacement message sends only on separate explicit action",
      `window.__calls.filter(c=>/sendRenterReply|sendOwnerReply/.test(c.name)).length===${sendsBeforeReplacement + 1}`,
    );

    await ok(
      "replacement accept uses actual operator arguments",
      `window.__calls.some(c=>c.name==='quick_reply_replacements:acceptBasket'&&c.args.dryRun===false)`,
    );
    await tap(close);

    await ev(
      `{window.__fixture.rows[3]=window.__originalReplacement;window.__fixture.changed();}`,
    );
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
    await ev(
      `{const row=window.__fixture.rows[1];row.items=[{name:'Sony FX6',qty:1,image_url:'/gear0.png'},{name:'Sigma 24-70',qty:1,image_url:'/gear1.png'},{name:'Retained tripod',qty:1,image_url:'/gear2.png'}];row.requested_items=row.items.map(item=>({...item,origin:'basket'}));row.availability.status='conflict';row.availability.items=row.items.map((item,index)=>({name:item.name,available:index===2,requested:1,total_units:1,free:index===2?1:0,booked:index===2?0:1,pending:0}));document.dispatchEvent(new Event('visibilitychange'));}`,
    );
    await pause(150);
    await tap(contains("Find replacement"));
    await ok(
      "website replacement reads its booking",
      `window.__calls.some(c=>c.name==='dbcinema_chat:replacementBasketOptions'&&c.args.booking_id)`,
    );
    await ok(
      "website offers two complete sets for all unavailable lines",
      `(()=>{const choices=[...document.querySelector('[aria-label="Replacement options"]').querySelectorAll('button[aria-pressed]')];return choices.length===2&&choices.every(choice=>choice.querySelectorAll('img').length===2);})()`,
    );
    const websiteSendCount = await ev(
      `window.__calls.filter(c=>c.name==='dbcinema_chat:sendOwnerReply').length`,
    );
    await tap(button("Use complete set in booking"));
    await ok(
      "website replacement approval uses website guarded action",
      `window.__calls.some(c=>c.name==='dbcinema_chat:acceptReplacementBasket'&&c.args.booking_id&&c.args.dryRun===false)`,
    );
    await ok(
      "website replacement approval does not send",
      `window.__calls.filter(c=>c.name==='dbcinema_chat:sendOwnerReply').length===${websiteSendCount}`,
    );
    await tap(button("Send replacement offer"));
    await ok(
      "website replacement separate send reaches website chat",
      `window.__calls.filter(c=>c.name==='dbcinema_chat:sendOwnerReply').length===${websiteSendCount + 1}`,
    );
    await tap(contains("Rental controls"));
    await tap(button("Refund"));
    await pause(100);
    await ok(
      "website controls load authoritative rental",
      `window.__calls.some(c=>c.name==='dbcinema_chat:rentalControls'&&c.args.booking_id)`,
    );
    await tap(button("Reschedule"));
    fs.writeFileSync(
      root + `/db-controls-${width}.png`,
      Buffer.from(
        (
          await c.cmd("Page.captureScreenshot", {
            captureBeyondViewport: false,
          })
        ).data,
        "base64",
      ),
    );
    await tap(button("Change rental"));
    await tap(button("＋ Add equipment"));
    await ok(
      "website equipment browser is inline and read only",
      `document.querySelector('[aria-label="Add DB Cinema equipment"]')&&!window.__calls.some(c=>c.name==='dbcinema_chat:addEquipment')`,
    );
    await tap(button("Cancel"));
    await ok(
      "website equipment cancellation leaves rental untouched",
      `!document.querySelector('[aria-label="Add DB Cinema equipment"]')&&!window.__calls.some(c=>c.name==='dbcinema_chat:addEquipment')`,
    );
    await tap(button("＋ Add equipment"));
    await ev(
      `{const i=document.querySelector('[aria-label="Search DB Cinema equipment"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'Nothing matches');i.dispatchEvent(new Event('input',{bubbles:true}));}`,
    );
    await pause(50);
    await tap(button("Search"));
    await ok(
      "website equipment empty search is clear",
      `document.body.textContent.includes('No bookable equipment matches')`,
    );
    await ev(
      `{const i=document.querySelector('[aria-label="Search DB Cinema equipment"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'Tripod');i.dispatchEvent(new Event('input',{bubbles:true}));}`,
    );
    await pause(50);
    await tap(button("Search"));
    await tap(
      `document.querySelector('[aria-label="Choose Manfrotto Tripod"]')`,
    );
    await tap(button("Change"));
    await tap(
      `document.querySelector('[aria-label="Choose Manfrotto Tripod"]')`,
    );
    await ev(
      `{const i=document.querySelector('[aria-label="Equipment quantity"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'2');i.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[aria-label="Add DB Cinema equipment"] input[type="checkbox"]').click();}`,
    );
    await pause(50);
    await ev(
      `{const i=document.querySelector('[aria-label="Equipment change reason"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'Operator approved tripod addition');i.dispatchEvent(new Event('input',{bubbles:true}));}`,
    );
    await pause(50);
    await tap(button("Review addition"));
    await ok(
      "website full kit quote remains read only until confirmation",
      `window.__calls.some(c=>c.name==='dbcinema_chat:previewEquipmentAddition')&&!window.__calls.some(c=>c.name==='dbcinema_chat:addEquipment')&&!!document.querySelector('[aria-label="Review equipment change"]')`,
    );
    await ok(
      "website quantity and complimentary quote retain exact selection",
      `window.__calls.some(c=>c.name==='dbcinema_chat:previewEquipmentAddition'&&c.args.qty===2&&c.args.complimentary===true)`,
    );
    await ok(
      "equipment review owns the panel footer",
      `[...document.querySelectorAll('[aria-label="Rental controls"] footer')].every(e=>getComputedStyle(e).display==='none')`,
    );
    fs.writeFileSync(
      root + `/db-equipment-review-${width}.png`,
      Buffer.from(
        (
          await c.cmd("Page.captureScreenshot", {
            captureBeyondViewport: false,
          })
        ).data,
        "base64",
      ),
    );
    await tap(button("Edit change"));
    await tap(button("Review addition"));
    await ev(`window.__staleEquipmentOnce=true`);
    await tap(button("Confirm equipment addition"));
    await ok(
      "confirmed source refusal returns to a fresh equipment review",
      `!document.querySelector('[aria-label="Add DB Cinema equipment"]')&&document.body.textContent.includes('quote changed')`,
    );
    await tap(button("＋ Add equipment"));
    await tap(
      `document.querySelector('[aria-label="Choose Manfrotto Tripod"]')`,
    );
    await ev(
      `{const i=document.querySelector('[aria-label="Equipment change reason"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'Operator approved tripod addition');i.dispatchEvent(new Event('input',{bubbles:true}));}`,
    );
    await pause(50);
    await tap(button("Review addition"));
    await ev(`window.__failEquipmentOnce=true`);
    await tap(button("Confirm equipment addition"));
    await ok(
      "uncertain website addition keeps a saved request",
      `document.body.textContent.includes('Check this saved request')&&!!document.querySelector('[aria-label="Add DB Cinema equipment"]')`,
    );
    await tap(button("Check saved equipment change"));
    await ok(
      "website addition retries exact reviewed request",
      `(()=>{const calls=window.__calls.filter(c=>c.name==='dbcinema_chat:addEquipment');return calls.length===3&&calls[0].args.request_id!==calls[1].args.request_id&&calls[1].args.request_id===calls[2].args.request_id&&calls.every(c=>c.args.expected_snapshot==='fixture-booking-version'&&c.args.expected_quote==='fixture-equipment-quote'&&c.args.operator_confirmed===true);})()`,
    );
    await tap(
      `document.querySelector('[aria-label="Remove Manfrotto Tripod"]')`,
    );
    await ev(
      `{const i=document.querySelector('[aria-label="Equipment change reason"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'Operator approved tripod removal');i.dispatchEvent(new Event('input',{bubbles:true}));}`,
    );
    await pause(50);
    await tap(button("Review removal"));
    await ok(
      "website removal review does not alter kit",
      `!window.__calls.some(c=>c.name==='dbcinema_chat:removeEquipment')`,
    );
    await tap(button("Edit change"));
    await tap(button("Review removal"));
    await tap(button("Confirm equipment removal"));
    await ok(
      "website removal binds snapshot and exact line",
      `window.__calls.some(c=>c.name==='dbcinema_chat:removeEquipment'&&c.args.listing_id==='fixture-tripod'&&c.args.expected_snapshot==='fixture-booking-version'&&c.args.operator_confirmed===true)`,
    );
    await tap(button("Reschedule"));
    await ev(
      `{const i=document.querySelector('[aria-label="Date change reason"]');const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(i,'Operator approved later collection');i.dispatchEvent(new Event('input',{bubbles:true}));}`,
    );
    await pause(50);
    await tap(button("Review dates"));
    await ok(
      "website dates preview is read only",
      `window.__calls.some(c=>c.name==='dbcinema_chat:previewRentalDates')&&!window.__calls.some(c=>c.name==='dbcinema_chat:applyRentalDates')`,
    );
    await tap(button("Cancel date change"));
    await tap(button("Review dates"));
    await tap(button("Confirm date change"));
    await ok(
      "website date apply binds reviewed snapshot",
      `window.__calls.some(c=>c.name==='dbcinema_chat:applyRentalDates'&&c.args.expected_snapshot==='fixture-booking-version'&&c.args.operator_confirmed===true)`,
    );
    await ev(
      `{const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;for(const [label,value]of [['Rental refund amount','12.50'],['Rental refund reason','Operator approved rental discount']]){const i=document.querySelector('[aria-label="'+label+'"]');setter.call(i,value);i.dispatchEvent(new Event('input',{bubbles:true}));}}`,
    );
    await pause(50);
    await tap(button("Review rental refund"));
    await ok(
      "website refund waits for explicit confirmation",
      `!window.__calls.some(c=>c.name==='dbcinema_chat:refundRental')`,
    );
    await tap(button("Cancel refund"));
    await tap(button("Review rental refund"));
    await tap(button("Confirm rental refund"));
    await ok(
      "website refund preserves website workflow and exact pence",
      `window.__calls.some(c=>c.name==='dbcinema_chat:refundRental'&&c.args.amount_pence===1250&&c.args.request_id&&c.args.operator_confirmed===true)`,
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
