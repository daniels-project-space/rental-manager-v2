"""Recipe: decline order."""
from typing import Any


async def run(page, payload: dict[str, Any], *, live: bool) -> dict[str, Any]:
    candidates = [
        '[data-testid="order-decline-button"]',
        'button[aria-label="Decline"]',
        'button:has-text("Decline")',
        'button:has-text("Reject")',
    ]
    btn = None
    for sel in candidates:
        try:
            handle = page.locator(sel).first
            if await handle.count() > 0 and await handle.is_visible():
                btn = handle
                break
        except Exception:
            continue
    if btn is None:
        return {"status": "recipe_failed", "error": "decline-button not found"}

    if not live:
        return {"status": "shadow_aborted", "reason": "live=false"}

    async def _submit() -> None:
        await btn.click()
        # If a confirm modal pops, click Yes/Confirm.
        for sel in ['button:has-text("Confirm")', 'button:has-text("Yes")']:
            try:
                modal_btn = page.locator(sel).first
                if await modal_btn.count() > 0 and await modal_btn.is_visible():
                    await modal_btn.click()
                    break
            except Exception:
                continue
        await page.wait_for_load_state("networkidle", timeout=10_000)

    return {"status": "shadow_aborted", "submit": _submit}
