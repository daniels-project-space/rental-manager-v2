"""Recipe: mark order picked up."""
from typing import Any


async def run(page, payload: dict[str, Any], *, live: bool) -> dict[str, Any]:
    candidates = [
        '[data-testid="order-mark-picked-up"]',
        'button[aria-label="Mark as picked up"]',
        'button:has-text("Mark as picked up")',
        'button:has-text("Picked up")',
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
        return {"status": "recipe_failed", "error": "mark-picked-up button not found"}

    if not live:
        return {"status": "shadow_aborted", "reason": "live=false"}

    async def _submit() -> None:
        await btn.click()
        await page.wait_for_load_state("networkidle", timeout=10_000)

    return {"status": "shadow_aborted", "submit": _submit}
