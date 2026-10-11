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

## Calendar correction — 11 October 2026
- Preserve compact calendar rows, bars and item tiles. No handover cards or agenda replacement.
- Pickup/return clocks remain at the corresponding bar endpoints, with brighter 12px clocks and endpoint ticks. Narrow same-day bars put the return clock below to avoid a collision.
- Renter names scale with the visible bar width (up to 15px), then shrink only when measured text needs to fit. Mobile horizontal scrolling still recalculates the visible name segment.
- Actual fixture UI checked at 1440, 1024, 768 and 390px, including horizontal pan, clipping, original compact bar heights, calendar controls and no page overflow. Typecheck and 18 focused regressions passed.
- Evidence: `/root/CODEX_ARTIFACTS/rental-manager/calendar-compact-endpoints/` (screenshots and fixture-only receipt). No real renter messages or rental/listing changes.
- Saved locally for the final production batch; broader Quick Reply audit remains open.

## Local rebuild checkpoint — 11 October 2026

Production has not been changed by this rebuild. Calendar correction is saved in `eb8c694`.

- The workspace now has a dedicated stylesheet; legacy workspace selectors were removed. Closed view follows the reference's list/preview ratio; opening a conversation uses a 50/50 split. The portal only targets its inline pane. Mobile and shorter desktop views cannot fall back to a body overlay.
- Actual photo nodes animate outward and fold back. Node identity and row, parent, sibling and page geometry are asserted before/during/after. Touch, focus, Escape and failed-photo fallback remain wired.
- Confirmed sends immediately demote answered threads. Decline hides the queue entry while keeping its conversation open. Disregard/decline use owner-only indexed preference metadata and genuine renter watermarks, including refresh and filters. Approval does not falsely hide a request.
- Native renter timestamps now ignore owner activity and use actual renter history or stable request creation. DB Cinema requires the paired local source fix in `/root/dbcinema-queue-watermark`: `adminInbox` exposes an account-scoped renter-only timestamp using one indexed message read. No rental/message/listing write path changed.
- All six newly compact secondary panels render actual components with populated fixture data. Automatic packing, expansion, desktop pairs and full-width phone content pass at 1440/1024/768/390. Screenshots were inspected for Item Cycle and Scorecard, including mobile.
- Reference-size desktop measurements: title 32px; portraits 52×52px; toolbar 38px versus reference39; rows96px versus reference94; closed queue ratio64.63% versus reference64.68%. The layout was inspected repeatedly and spacing was refined after those comparisons. This is geometry evidence, not a claim of an identical bitmap with different customer data and requested new controls.

### Evidence

- `/root/CODEX_ARTIFACTS/rental-manager/quick-reply-reference-rebuild/full-current/`: individual fixture controls, 48 phone/keyboard/subpanel close conditions, queue lifecycle, design and actual photo fan proofs.
- `/root/CODEX_ARTIFACTS/rental-manager/quick-reply-reference-rebuild/dashboard-all/`: six actual secondary panels, packing and compact calendar at four widths.
- `/root/CODEX_ARTIFACTS/rental-manager/quick-reply-reference-rebuild/reference-final/`: reference-size screenshot and measured differences.
- Full Rental Manager unit suite: 178 files, 2558 passed,14 skipped. Types and production Next build passed. Owner guard has zero failures.
- DB Cinema full synthetic test suite and types passed; exact renter-clock handler tests include >40 owner/bot/system messages, foreign account exclusion, request fallback, new renter activity and zero source writes.
- Final local browser rerun passed, including the reference measurement check. Both production builds passed locally. Graphs updated locally. No branch has been pushed. Paired DB Cinema source commit: `6cc4642`.

### Remaining release work

- Check the entire actual dashboard and permitted source reads with production writes blocked; preserve all prior safety gates.
- Release the paired DB Cinema read field/index and Rental Manager changes as the final Git batch, qualify current-head CI, verify exact production aliases and inspect the deployed UI. The broader goal remains active until this is done.
