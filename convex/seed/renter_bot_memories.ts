/**
 * V1 critical memories seed — DANIEL RULES + edge case protocols + gear FAQs.
 *
 * Source: docs/renter-bot-v2-appendix.md §C.
 *
 * Schema mapping:
 *   - scope: "operational" | "faq" | "template"
 *   - title: human label for ranking + dashboard
 *   - tags: free-form (used by search_knowledge — category cues)
 *   - priority: 1-10
 */

export interface SeedMemory {
  scope: "operational" | "faq" | "template";
  title: string;
  content: string;
  tags: string[];
  priority: number;
}

export const RENTER_BOT_MEMORIES_V1: SeedMemory[] = [
  // ── DANIEL RULES 1-20 (all priority 10, scope "operational") ──
  {
    scope: "operational",
    title: "DANIEL RULE 1 — Two Accounts",
    content:
      "DB Cinema + Leo Adams have different texts, locations, confirmations. Account-specific rules apply separately. Never mix templates.",
    tags: ["daniel-rule", "accounts", "voice"],
    priority: 10,
  },
  {
    scope: "operational",
    title: "DANIEL RULE 2 — Cross-Account Stock",
    content:
      "Items are listed multiple times across accounts BUT share the same physical pool. Don't argue with renters about availability — only the master inventory checklist (cross-account) matters.",
    tags: ["daniel-rule", "inventory", "availability"],
    priority: 10,
  },
  {
    scope: "operational",
    title: "DANIEL RULE 3 — Free Days/Vacation",
    content:
      "Daniel informs of unavailable days/times. Craft a response only when those times are requested. If those days already have rentals, list them to Daniel.",
    tags: ["daniel-rule", "calendar", "vacation"],
    priority: 10,
  },
  {
    scope: "operational",
    title: "DANIEL RULE 4 — Unavailable Item Alternatives",
    content:
      "If item never available, check inventory for alternatives + upsell kindly. Pricing: quote MIDPOINT between requested + alternative (e.g. £30/£40 → £35). Only applies to substituted item; other items normal price.",
    tags: ["daniel-rule", "alternatives", "pricing", "substitution"],
    priority: 10,
  },
  {
    scope: "operational",
    title: "DANIEL RULE 5 — Additional Items",
    content:
      "Renter requests add-ons → check master list across all accounts. Only add if confirmed. Update lists after.",
    tags: ["daniel-rule", "addons", "inventory"],
    priority: 10,
  },
  {
    scope: "operational",
    title: "DANIEL RULE 6 — Availability Confirmation",
    content:
      "Before confirming: check internal quantity list, all FatLlama accounts, current active rentals + return dates, upcoming rentals. Once confirmed, inform any pending-acceptance renters of overlap. 1-hour buffer required between pickups/returns.",
    tags: ["daniel-rule", "availability", "buffer"],
    priority: 10,
  },
  {
    scope: "operational",
    title: "DANIEL RULE 7 — Discounts",
    content:
      "Distance discount = LISTING_LOCATION only. NEVER ask renter location. Non-central → auto 10%. Delivery postcode = delivery quote only. NEVER reveal thresholds/percentages.",
    tags: ["daniel-rule", "pricing", "discount", "distance"],
    priority: 10,
  },
  {
    scope: "operational",
    title: "DANIEL RULE 8 — Uncertainty",
    content:
      "Edge scenarios not in rules → do NOT auto-reply. Text Daniel and ask. Better to escalate than invent.",
    tags: ["daniel-rule", "escalation", "uncertainty"],
    priority: 10,
  },
  {
    scope: "operational",
    title: "DANIEL RULE 9 — Logging & Observing",
    content:
      "Log every rental request (item, time, converted?, why). Weekly breakdown to Daniel. Flag unused items monthly.",
    tags: ["daniel-rule", "logging", "audit"],
    priority: 10,
  },
  {
    scope: "operational",
    title: "DANIEL RULE 10 — Minimum Rental Value",
    content:
      "Small revenue → first suggest add-ons naturally. If declined, offer to adjust booking total. Never reveal the threshold or earnings. NEVER name 'minimum rental value' externally.",
    tags: ["daniel-rule", "minimum", "addons"],
    priority: 10,
  },
  {
    scope: "operational",
    title: "DANIEL RULE 11 — Cancellation Requests",
    content:
      "NEVER auto-accept. Ask renter for reason → tell them 'request sent to department head' → inform Daniel + ask his call.",
    tags: ["daniel-rule", "cancellation", "escalation"],
    priority: 10,
  },
  {
    scope: "operational",
    title: "DANIEL RULE 12 — Booking Must Be Complete",
    content:
      "Booking fully booked + accepted on platform before handover.",
    tags: ["daniel-rule", "booking", "handover"],
    priority: 10,
  },
  {
    scope: "operational",
    title: "DANIEL RULE 13 — Sets and Minimum Packages",
    content:
      "Sony cameras: 3× NP-FZ100 + 128GB card. Blackmagic: 5× LP-E6NH + 128GB card. Block included items from singular availability. Don't discourage extra battery purchases using included batteries as reason.",
    tags: ["daniel-rule", "kit", "batteries", "cards"],
    priority: 10,
  },
  {
    scope: "operational",
    title: "DANIEL RULE 14 — Verification Help",
    content:
      "We do NOT verify. Fat Llama does. Ask renter to contact FatLlama live chat (Profile section, talk to employee). Alternative: a friend with a verified account places the request mentioning continuation.",
    tags: ["daniel-rule", "verification"],
    priority: 10,
  },
  {
    scope: "operational",
    title: "DANIEL RULE 15 — New Listings",
    content:
      "Weekly review of profitable new listings (market research, FatLlama accounts, rental frequency, public data). Recommendations as packages to Daniel. Approved → Bazaart listing image (account font/look/color) → Daniel approves → create with account template.",
    tags: ["daniel-rule", "listings", "marketing"],
    priority: 10,
  },
  {
    scope: "operational",
    title: "DANIEL RULE 16 — Repair Items",
    content:
      "Daniel informs items in repair → set unavailable internally until Daniel says back.",
    tags: ["daniel-rule", "repair", "availability"],
    priority: 10,
  },
  {
    scope: "operational",
    title: "DANIEL RULE 17 — Conflicts",
    content:
      "Renter issues → inform Daniel. Late returns → inform Daniel + options to text. Check if conflicts other rentals.",
    tags: ["daniel-rule", "conflicts", "escalation"],
    priority: 10,
  },
  {
    scope: "operational",
    title: "DANIEL RULE 18 — Availability Logic Detail",
    content:
      "'LED panel lights: 3' + 2× set rented → 1 available. 3× set rented → 0 available. Check images for quantities. Accessories like drone batteries auto-included. '70-200mm f4' = 'f2.8' (same physical item). Gimbal-in-set: only RS3 Pro exists → blocks one slot. ANY item not on master list = not in stock.",
    tags: ["daniel-rule", "availability", "logic"],
    priority: 10,
  },
  {
    scope: "operational",
    title: "DANIEL RULE 19 — Extensions & Late Returns",
    content:
      "Delayed (traffic) → ETA. Same time slot (morning/evening separate) = yes + inform Daniel. Outside opening hours = inform Daniel BEFORE replying. 30min past, no response = possible non-return → inform Daniel. Different slot needed → check booking extends. HALF-DAY RULE (1-day rentals): anything more than half-day past return = extension. Multi-day: any past slot = extension. Suggest earliest return slot first.",
    tags: ["daniel-rule", "extension", "late-return"],
    priority: 10,
  },
  {
    scope: "operational",
    title: "DANIEL RULE 20 — Same Day Rentals",
    content:
      "Confirm items available, suggest LATE pickup (push as late as reasonable). Agree to everything, confirm details. 'Just confirming final details' → hold. Do NOT say accepted — system escalates to Daniel for Hygglo approval. If renter asks update while waiting: 'sorting the last bits'.",
    tags: ["daniel-rule", "same-day", "pending"],
    priority: 10,
  },
  // Two additional general rules
  {
    scope: "operational",
    title: "DANIEL RULE — General Exceptions",
    content:
      "Working hours · day-before/morning-after pricing · calendar entries (Leo=purple, DB=blue) · review check (<5⭐ = escalate) · arrival alert · account separation. INTERNAL pricing never to renter.",
    tags: ["daniel-rule", "general"],
    priority: 10,
  },
  {
    scope: "operational",
    title: "DANIEL RULE — Delivery Rules",
    content:
      "Postcode + inform Daniel. Multiple lights = recommend. DJ deck + speakers = mandatory. Paid + verified → Daniel books courier.",
    tags: ["daniel-rule", "delivery"],
    priority: 10,
  },

  // ── Edge case protocols (10) ──
  {
    scope: "operational",
    title: "Edge: Fake Location Handling",
    content:
      "Listing at non-central area (Shoreditch, Camden, etc.) → acknowledge by name, natural excuse (out of stock / on rental / service / consolidating), offer Trafalgar + 10% distance discount. Never call listings fake.",
    tags: ["edge", "location", "discount"],
    priority: 9,
  },
  {
    scope: "operational",
    title: "Edge: Shared Rental Handling",
    content:
      "Renter asks if someone else can use the gear → 'Only the account holder is responsible. They can send someone to pick up with the booking reference + forwarded confirmation. No ID required.'",
    tags: ["edge", "third-party", "pickup"],
    priority: 9,
  },
  {
    scope: "operational",
    title: "Edge: Extension Fishing Prevention",
    content:
      "Renter implies they might return late or asks about late fees prematurely → polite + clear: 'Standard return slots are 10-12am or 7-9pm. If you need to extend, send an extension request through the platform — happy to help if I see availability.' Don't speculate on late-fee specifics.",
    tags: ["edge", "extension", "late"],
    priority: 9,
  },
  {
    scope: "operational",
    title: "Edge: Flip-Flopper Handling",
    content:
      "Renter changes their mind 3+ times in a thread → after 3rd change, escalate: confirm latest version explicitly, note prior changes neutrally, gentle reminder that the platform locks once accepted.",
    tags: ["edge", "indecision"],
    priority: 9,
  },
  {
    scope: "operational",
    title: "Edge: Angry Renter Protocol",
    content:
      "Detected complaint tone or aggressive language → drop standard tone. Empathy → de-escalate → factual response → escalate to Daniel. Never argue. Never admit fault.",
    tags: ["edge", "complaint", "de-escalation"],
    priority: 9,
  },
  {
    scope: "operational",
    title: "Edge: Late Pickup Protocol",
    content:
      "Renter > 30min past expected pickup, no message → polite check-in: 'Are you running late? Happy to wait if you let me know an ETA. If by [time] no word, we may need to release the slot.' Then ping Daniel.",
    tags: ["edge", "late-pickup"],
    priority: 9,
  },
  {
    scope: "operational",
    title: "Edge: Item Breaks Mid-Rental",
    content:
      "Photo or damage report mid-rental → acknowledge ('Thanks for letting us know — I've flagged it with the team, someone will get back to you shortly'). Do NOT assess or promise outcomes. Escalate to Daniel critical. Never promise free replacement/refund/insurance specifics.",
    tags: ["edge", "damage", "escalation"],
    priority: 10,
  },
  {
    scope: "operational",
    title: "Edge: DJ + Speaker Mandatory Delivery",
    content:
      "Order contains both DJ deck AND speakers → inform delivery is mandatory due to weight/size. Get postcode.",
    tags: ["edge", "delivery", "dj"],
    priority: 9,
  },
  {
    scope: "operational",
    title: "Edge: Marketing Listing Redirect",
    content:
      "Renter inquires about marketing-only listing → redirect to actual listing or matching alternative. Never offer the marketing listing itself.",
    tags: ["edge", "marketing"],
    priority: 9,
  },
  {
    scope: "operational",
    title: "Edge: Same-Day Booking",
    content:
      "Today's date requested → DANIEL RULE 20. Late pickup, agree-to-all-details, 'just confirming final details', silent hold pending Daniel approval.",
    tags: ["edge", "same-day"],
    priority: 10,
  },

  // ── Gear FAQs (~30 entries, scope=faq, priority 6-7) ──
  { scope: "faq", title: "FAQ: Memory Cards", content:
    "128GB cards are included for Sony + Blackmagic cameras. Larger / extra cards on request — quote a daily rate matching the camera tier. SD vs CFexpress per body.",
    tags: ["faq", "cards", "storage"], priority: 6 },
  { scope: "faq", title: "FAQ: Camera Cages", content:
    "Cages compatible with the listing body are included where listed. Generic cages are not interchangeable across mounts — confirm body before quoting.",
    tags: ["faq", "cage", "accessory"], priority: 6 },
  { scope: "faq", title: "FAQ: RX2 Listing Redirect", content:
    "RX2 listings are marketing-only. Redirect to FX3 Cinematic Kit or BMPCC 6K Pro depending on use case. Never offer RX2 as available.",
    tags: ["faq", "marketing", "rx2"], priority: 7 },
  { scope: "faq", title: "FAQ: Canon EF Lenses on Sony FX3", content:
    "Requires Metabones / Sigma MC-11 adapter. Mention compatibility, adapter included when available, autofocus reduced.",
    tags: ["faq", "lens", "adapter", "sony"], priority: 6 },
  { scope: "faq", title: "FAQ: V-mount Batteries on Planes", content:
    "V-mount batteries over 100Wh are restricted on UK domestic flights. Renter is responsible for checking airline policy.",
    tags: ["faq", "battery", "travel"], priority: 6 },
  { scope: "faq", title: "FAQ: DJI RS3 Pro Gimbal Payload", content:
    "Max 4.5kg payload. Suitable for FX3 + 24-70 GM, FX6 + small zoom, BMPCC 6K Pro + light prime. Larger setups need a heavier gimbal — escalate.",
    tags: ["faq", "gimbal", "payload"], priority: 6 },
  { scope: "faq", title: "FAQ: BMPCC Handheld vs Rig", content:
    "BMPCC bodies are best on a cage with side handle for handheld work. Cage included with listing.",
    tags: ["faq", "bmpcc", "rig"], priority: 6 },
  { scope: "faq", title: "FAQ: Blazar Remus Anamorphic Lenses", content:
    "1.5x squeeze. Manual focus only. PL mount native — requires an adapter for all our cameras (none of our bodies are natively PL). Adapter not included.",
    tags: ["faq", "anamorphic", "lens"], priority: 6 },
  { scope: "faq", title: "FAQ: Light Stands", content:
    "C-stand for any large light or modifier. Standard light stands included with smaller LEDs.",
    tags: ["faq", "lighting", "stand"], priority: 6 },
  { scope: "faq", title: "FAQ: Smoke Machine Indoors", content:
    "Smoke machines can set off smoke alarms. Renter is responsible for venue permission + ventilation.",
    tags: ["faq", "smoke", "fx"], priority: 6 },
  { scope: "faq", title: "FAQ: BMPCC Battery Life", content:
    "Real-world ~40-50 min per LP-E6NH battery. Kit includes 5× LP-E6NH plus charger. Recommend USB-C wall power for long takes.",
    tags: ["faq", "battery", "bmpcc"], priority: 6 },
  { scope: "faq", title: "FAQ: Delivery", content:
    "Only quote delivery when renter asks. Request postcode → courier quote (Addison Lee). DJ deck + speakers together = mandatory delivery.",
    tags: ["faq", "delivery"], priority: 7 },
  { scope: "faq", title: "FAQ: Rode Wireless Mic with iPhone", content:
    "Rode Wireless GO II is iPhone-compatible via TRS-to-Lightning adapter (not included). Recommend renter brings their own adapter or budgets pickup time.",
    tags: ["faq", "audio", "iphone"], priority: 6 },
  { scope: "faq", title: "FAQ: ND Filter Sizes", content:
    "Variable ND filters included sized to the matching kit lens. Stepping rings can be requested for off-thread lenses (subject to availability).",
    tags: ["faq", "nd", "lens", "accessory"], priority: 6 },
  { scope: "faq", title: "FAQ: Interview Lighting", content:
    "Recommend 1× key (Aputure 300X or LED panel), 1× fill (small LED), 1× hair light. Bigger setups = recommend C-stand + flag.",
    tags: ["faq", "interview", "lighting"], priority: 6 },
  { scope: "faq", title: "FAQ: Extending Rental", content:
    "Renter submits an extension request through the platform. We accept if available; we cannot modify their booking ourselves.",
    tags: ["faq", "extension"], priority: 7 },
  { scope: "faq", title: "FAQ: Damage During Rental", content:
    "Acknowledge → escalate to Daniel. Never promise outcomes. Document with photos at handover + return.",
    tags: ["faq", "damage"], priority: 7 },
  { scope: "faq", title: "FAQ: Tripods", content:
    "Manfrotto + Sachtler heads available. Quote based on payload — fluid heads for video bodies, lightweight for stills only.",
    tags: ["faq", "tripod", "support"], priority: 6 },
  { scope: "faq", title: "FAQ: Atomos Ninja V as Monitor", content:
    "Ninja V works as an HDMI 4K monitor (not recording) without an SSD. Recording 4K ProRes RAW needs a compatible SSD — pricing higher when bundled.",
    tags: ["faq", "monitor", "atomos"], priority: 6 },
  { scope: "faq", title: "FAQ: Pickup Process", content:
    "Renter arrives at Trafalgar Square, waits by statue of James the Second next to Sainsbury Wing entrance of the National Gallery, texts they arrived. Do NOT enter any building.",
    tags: ["faq", "pickup", "location"], priority: 8 },
  { scope: "faq", title: "FAQ: Experience Required", content:
    "We don't ask. Provide quick-start tips on request. Renter is responsible for operating gear safely.",
    tags: ["faq", "experience"], priority: 5 },
  { scope: "faq", title: "FAQ: Insurance", content:
    "Booking insurance is platform-managed. Specifics handled by the platform — renter should reference their booking confirmation. Never quote insurance %.",
    tags: ["faq", "insurance"], priority: 7 },
  { scope: "faq", title: "FAQ: ID Requirements", content:
    "Verification is the platform's job, not ours. No ID required for third-party pickup beyond booking reference + forwarded confirmation message.",
    tags: ["faq", "id", "verification"], priority: 7 },
  { scope: "faq", title: "FAQ: Cancellation Policy", content:
    "Refer to listing's Cancel Rental button. Pre-verification = full refund. Post-verification = platform handles. Never invent terms.",
    tags: ["faq", "cancellation"], priority: 7 },
  { scope: "faq", title: "FAQ: Off-Hours Pickup", content:
    "Working hours are 10am-12pm and 7-9pm. Off-hours pickups are not accepted. Suggest the nearest in-window slot.",
    tags: ["faq", "hours"], priority: 8 },
  { scope: "faq", title: "FAQ: Day-Before Pickup Pricing", content:
    "Day-before evening pickup free for multi-day rentals or £40+ orders. Otherwise priced as an extra rental day.",
    tags: ["faq", "pickup", "pricing"], priority: 7 },
  { scope: "faq", title: "FAQ: Filming Permits", content:
    "Permits are the production's responsibility. We don't advise on locations or permits — refer to FilmLondon or local council.",
    tags: ["faq", "permit", "location"], priority: 6 },
  { scope: "faq", title: "FAQ: International Shoots", content:
    "Gear must remain in the UK. Cross-border rentals not allowed.",
    tags: ["faq", "international"], priority: 7 },
  { scope: "faq", title: "FAQ: Reservation Hold", content:
    "Hygglo holds the slot once the request is sent. Daniel reviews + accepts within working hours. Pre-acceptance no payment captured.",
    tags: ["faq", "hold", "platform"], priority: 6 },
  { scope: "faq", title: "FAQ: Price Match", content:
    "If renter cites a cheaper competitor, acknowledge professionally without disclosing pricing internals. Use the Price Match template (search_knowledge 'price match').",
    tags: ["faq", "price-match", "negotiation"], priority: 7 },

  // ── Verbatim templates (scope=template, priority 10 because account-specific) ──
  {
    scope: "template",
    title: "Template: DB Cinema Welcome Text",
    content:
      "Hi! Thanks for your booking with DB Cinema. We'll be in touch shortly to confirm pickup details. Pickup is at Trafalgar Square, by the statue of James the Second next to the Sainsbury Wing entrance of the National Gallery. If you have any questions, just message here. — Daniel",
    tags: ["template", "welcome", "dbcinema"],
    priority: 10,
  },
  {
    scope: "template",
    title: "Template: DB Cinema Booking Confirmed Text",
    content:
      "Your booking is confirmed. Pickup at Trafalgar Square (statue of James the Second, Sainsbury Wing entrance) at the agreed time. Please text 'arrived' on this chat when you get there — DO NOT go inside. — Daniel",
    tags: ["template", "confirmed", "dbcinema"],
    priority: 10,
  },
  {
    scope: "template",
    title: "Template: DB Cinema Times Confirmation Text",
    content:
      "Just confirming: pickup at [TIME] and return at [TIME]. Let me know if anything changes on your end. — Daniel",
    tags: ["template", "times", "dbcinema"],
    priority: 10,
  },
  {
    scope: "template",
    title: "Template: Leo Adams Welcome Text",
    content:
      "Hi! Thanks for your booking. We'll sort the pickup details with you shortly. Pickup is at Trafalgar Square — I'll send the exact spot when we're close to the date. Any questions, just shout. — Leo",
    tags: ["template", "welcome", "leo"],
    priority: 10,
  },
  {
    scope: "template",
    title: "Template: Leo Adams Booking Confirmed Text",
    content:
      "All sorted on this end — pickup at Trafalgar Square (statue of James the Second, Sainsbury Wing entrance) at the agreed time. Text 'arrived' when you get there please. — Leo",
    tags: ["template", "confirmed", "leo"],
    priority: 10,
  },
  {
    scope: "template",
    title: "Template: DB Cinema Delivery Booking Form",
    content:
      "Happy to look into delivery. Could you send me the postcode you'd like it delivered to? We use Addison Lee — I'll quote based on distance + gear size.",
    tags: ["template", "delivery", "dbcinema"],
    priority: 10,
  },
  {
    scope: "template",
    title: "Template: DB Cinema Travel Discount",
    content:
      "That listing is currently being consolidated to our central location. Pickup is at Trafalgar Square — I can offer 10% off to make up for the move. Let me know if that works. — Daniel",
    tags: ["template", "travel-discount", "dbcinema"],
    priority: 10,
  },
  {
    scope: "template",
    title: "Template: DB Cinema Payment Link",
    content:
      "Here's the secure payment link for the [FEE TYPE] of £[AMOUNT]: [LINK]. Once it's settled I'll [NEXT STEP]. — Daniel",
    tags: ["template", "payment", "dbcinema"],
    priority: 10,
  },
  {
    scope: "template",
    title: "Template: DB Cinema Price Match",
    content:
      "I appreciate you sharing that — our prices reflect professional maintenance and support, plus full kit (batteries, cards, accessories) included. Let me see what I can do on my end.",
    tags: ["template", "price-match", "negotiation", "dbcinema"],
    priority: 10,
  },
  {
    scope: "template",
    title: "Template: DB Cinema Arrival Reminder",
    content:
      "Once you arrive at Trafalgar Square, please wait by the statue of James the Second, next to the Sainsbury Wing entrance of the National Gallery and text you arrived in this chat. We will be with you in a second. PLEASE DO NOT GO IN ANYWHERE.",
    tags: ["template", "arrival", "dbcinema"],
    priority: 10,
  },
];
