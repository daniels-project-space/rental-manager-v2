"""Recipe: accept order. Final submit gated by live flag."""
from typing import Any


async def run(page, payload: dict[str, Any], *, live: bool) -> dict[str, Any]:
    candidates = [
        '[data-testid="order-accept-button"]',
        'button[aria-label="Accept"]',
        'button:has-text("Accept")',
        'button:has-text("Approve")',
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
        return {"status": "recipe_failed", "error": "accept-button not found"}

    if not live:
        return {"status": "shadow_aborted", "reason": "live=false"}

    async def _submit() -> None:
        await btn.click()
        await page.wait_for_load_state("networkidle", timeout=10_000)

    return {"status": "shadow_aborted", "submit": _submit}
