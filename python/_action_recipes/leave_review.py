"""Recipe: leave a renter review (star rating + optional comment)."""
from typing import Any


async def run(page, payload: dict[str, Any], *, live: bool) -> dict[str, Any]:
    args = payload.get("args") or {}
    rating = int(args.get("rating") or 5)
    if rating < 1 or rating > 5:
        return {"status": "recipe_failed", "error": "rating out of range"}
    comment = args.get("comment") or ""

    # Find a "Leave review" CTA first
    cta_candidates = [
        '[data-testid="leave-review-button"]',
        'button:has-text("Leave a review")',
        'button:has-text("Leave review")',
        'a:has-text("Leave a review")',
    ]
    cta_clicked = False
    for sel in cta_candidates:
        try:
            handle = page.locator(sel).first
            if await handle.count() > 0 and await handle.is_visible():
                await handle.click()
                cta_clicked = True
                break
        except Exception:
            continue
    # If no CTA found, we may already be on the review form (deep-linked) — continue.
    _ = cta_clicked

    # Click the N-th star.
    star_candidates = [
        f'[data-testid="rating-star-{rating}"]',
        f'button[aria-label="Rate {rating} stars"]',
        f'[aria-label="{rating} stars"]',
    ]
    star = None
    for sel in star_candidates:
        try:
            handle = page.locator(sel).first
            if await handle.count() > 0 and await handle.is_visible():
                star = handle
                break
        except Exception:
            continue
    if star is None:
        return {"status": "recipe_failed", "error": f"rating star {rating} not found"}
    await star.click()

    # Optional comment.
    if comment:
        for sel in ['textarea[name="reviewComment"]', 'textarea[placeholder*="review" i]', 'textarea']:
            try:
                handle = page.locator(sel).first
                if await handle.count() > 0 and await handle.is_visible():
                    await handle.fill(comment)
                    break
            except Exception:
                continue

    # Submit button candidates
    submit_candidates = [
        '[data-testid="review-submit"]',
        'button:has-text("Submit review")',
        'button:has-text("Submit")',
        'button:has-text("Post")',
    ]
    btn = None
    for sel in submit_candidates:
        try:
            handle = page.locator(sel).first
            if await handle.count() > 0 and await handle.is_visible():
                btn = handle
                break
        except Exception:
            continue
    if btn is None:
        return {"status": "recipe_failed", "error": "review submit not found"}

    if not live:
        return {"status": "shadow_aborted", "reason": "live=false"}

    async def _submit() -> None:
        await btn.click()
        await page.wait_for_load_state("networkidle", timeout=10_000)

    return {"status": "shadow_aborted", "submit": _submit}
