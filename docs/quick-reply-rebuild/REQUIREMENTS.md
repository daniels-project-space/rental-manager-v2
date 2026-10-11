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
| Approved reference hierarchy, spacing, color and typography | Measured reference/actual screenshots; repeated vision review at desktop and mobile | Locally qualified; final live audit pending |
| Chat side view; no shading or overlay over the conversation; wide desktop split and reliable notification close | Actual desktop/short-height/mobile/notification UI; physical close clicks; no backdrop | Locally qualified; final live audit pending |
| Real listing tiles fan apart and fold back without row/widget/page reflow | Image node identity, parent/sibling geometry before/during/after animated hover; resolved photos | Locally qualified; final live audit pending |
| Priority always puts answered chats below unanswered chats; independent money/oldest sorts | Comparator regressions plus actual post-send fixture queue movement | Locally qualified; final live audit pending |
| Declined chat disappears from list; active chat stays open and allows follow-up; new renter message restores it | Fixture decline/send/close/new-message lifecycle; no real mutation | Locally qualified; final live audit pending |
| Disregard X hides until a newer renter message, across filters and refresh; owner replies do not restore it | Durable watermark regressions and fixture UI reload/filter/send/new-renter cases for both sources | Locally qualified; final live audit pending |
| Smaller secondary widgets below Return Hub arranged horizontally where readable | Actual full dashboard responsive screenshots, automatic packing and no overlap/blank-grid regressions | Locally qualified; final live audit pending |
| Whole mobile page, calendar, quick reply controls and subpanels have appropriate space | Actual 320/390/430/768 widths, keyboard/composer/scroll, every relevant panel and control | Locally qualified; final live audit pending |
| Preserve all earlier approved controls and information: accounts, money, elapsed wait, requested items, portraits/reviews, source stage/progress, stock, replacement whole-basket proposals, quick texts, context AI draft, confirmed rental changes | Source/caller/data audit; individually tested fixture buttons; permitted read-only source actions | Locally qualified; final live audit pending |
| Next-hour rail only inside ±60 minutes, duplicates only same person/same item/different accounts, DB Cinema messages/quick texts and source lifecycle | Existing contracts plus live read-only observations; no renter message test | Locally qualified; final live audit pending |
| Final production release | Full tests/typecheck/build, owner guards, graph update, exact Git deployment + canonical alias + live read-only vision checks | Locally qualified; final live audit pending |

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

## Whole-page qualification — 11 October 2026

Previous goal turn: progress (committed the rebuild and paired source clock; gathered full local control/queue/vision evidence).

- Inspected the real production dashboard at 1505/768/430/390/320 with mutation, messaging, finance and listing writes blocked. The 320px response-rate footer was the only overflowing card. Header account buttons also wrapped outside their fixed header height.
- Added a full-page harness that renders the actual `DashboardPage`, `AccountProvider`, `EditModeProvider`, deferred widgets and automatic grids. It replays owner-authorized read-only query snapshots, rather than manually recreating the page. All 60 panel/stat wrappers render without missing queries, boundary failures, JavaScript errors or duplicate-key warnings at five widths. No real write transport exists in this harness; screenshots can show photo placeholders because external DNS is blocked.
- On narrow phones, the app header gives account avatars a separate row; at320px the funnel and response-rate cards span both columns. The response footer wraps within its card. Price recommendations with no mapped inventory ID now have stable canonical-name keys; actual read data contained three such entries.
- Full-page physical close checks exposed a genuine scroll-context issue: opening a chat while its widget was above the viewport did not scroll back up, and the sticky app header could cover the close button. Alignment now scrolls in either direction. Desktop chat docking stays below the app header; phone chats naturally scroll past the header without an overlay. Normal and notification close are physically clicked in the actual full page at all five widths, and the desktop50/50 split is asserted there.
- Added the widget registry to the QA Tailwind inputs, so library-owned primary-panel span classes are present exactly as in the production build. Five primary panels are asserted to occupy the complete page width.
- Full isolated Quick Reply controls/phone/queue/fan/reference suite passed again after these changes. Standard dashboard suite passed. Live manual-send gate read back enabled; native manual sender and DB Cinema owner-send bridge remain wired to the existing real providers. No test message was sent.
- Both backend dry runs validate the intended production deployments and add only the indexed queue preference/read indexes; no indexes are deleted. No backend publish or Git push has occurred yet.

Evidence: `quick-reply-reference-rebuild/live-baseline/`, `full-page/`, `final-controls/`, `query-read-receipt.json`; backend dry-run logs and manual-send flag retained as local diagnostics. Final types/build and graph update precede the single Git release batch.
