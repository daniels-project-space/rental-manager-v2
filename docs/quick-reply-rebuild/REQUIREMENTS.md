# Quick Reply and mobile rebuild

User goal: restore the approved reference hierarchy through a ground-up Quick Reply rebuild, correct queue lifecycle, animate the actual equipment stack without moving page layout, compact the secondary dashboard and redesign the mobile experience.

## Release constraints
- Local commits during implementation; one production push after the complete audit passes.
- Never send a real renter a test message or mutate a real rental, listing, payment or return.
- Use isolated fixture transports for every write control; production inspection is read-only.
- Preserve models, real caller/data integrations, confirmations and source safety rails.

## Required evidence
| Requirement | Proof required | State |
| --- | --- | --- |
| Approved reference hierarchy, spacing, color and typography | Measured reference/actual screenshots; repeated vision review at desktop and mobile | Open |
| Chat side view; no shading or overlay over the conversation; wide desktop split and reliable notification close | Actual desktop/short-height/mobile/notification UI; physical close clicks; no backdrop | Open |
| Real listing tiles fan apart and fold back without row/widget/page reflow | Image node identity, parent/sibling geometry before/during/after animated hover; resolved photos | Open |
| Priority always puts answered chats below unanswered chats; independent money/oldest sorts | Comparator regressions plus actual post-send fixture queue movement | Open |
| Declined chat disappears from list; active chat stays open and allows follow-up; new renter message restores it | Fixture decline/send/close/new-message lifecycle; no real mutation | Open |
| Disregard X hides until a newer renter message, across filters and refresh; owner replies do not restore it | Durable watermark regressions and fixture UI reload/filter/send/new-renter cases for both sources | Open |
| Smaller secondary widgets below Return Hub arranged horizontally where readable | Actual full dashboard responsive screenshots, automatic packing and no overlap/blank-grid regressions | Open |
| Whole mobile page, calendar, quick reply controls and subpanels have appropriate space | Actual 320/390/430/768 widths, keyboard/composer/scroll, every relevant panel and control | Open |
| Preserve all earlier approved controls and information: accounts, money, elapsed wait, requested items, portraits/reviews, source stage/progress, stock, replacement whole-basket proposals, quick texts, context AI draft, confirmed rental changes | Source/caller/data audit; individually tested fixture buttons; permitted read-only source actions | Open |
| Next-hour rail only inside ±60 minutes, duplicates only same person/same item/different accounts, DB Cinema messages/quick texts and source lifecycle | Existing contracts plus live read-only observations; no renter message test | Open |
| Final production release | Full tests/typecheck/build, owner guards, graph update, exact Git deployment + canonical alias + live read-only vision checks | Open |

## Initial findings
- Stack expansion is a second static grid, changing equipment-cell layout. The original image nodes disappear during expansion.
- Docking requires both 760px width and 760px viewport height; shorter desktop viewports use an overlay.
- Priority blends earnings before a hard unanswered/replied partition, so expensive answered threads can outrank waiting renters.
- Local `acted` is a permanent ID set until reload; it never clears on new renter activity.
- DB Cinema dismissal is compared with all activity, so an owner message can wrongly reveal the chat.
- Actual native successful sends do not immediately notify the queue; DB Cinema also waits for polling.

Prior goal turn classification: progress (calendar/return-source behavior deployed and verified). This broader goal remains active; that release did not establish Quick Reply/reference/mobile completion.
