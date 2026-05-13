"""Recipe: mark order returned."""
from typing import Any


async def run(page, payload: dict[str, Any], *, live: bool) -> dict[str, Any]:
    notes = (payload.get("args") or {}).get("conditionNotes") or ""

    candidates = [
        '[data-testid="order-mark-returned"]',
        'button[aria-label="Mark as returned"]',
        'button:has-text("Mark as returned")',
        'button:has-text("Returned")',
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
        return {"status": "recipe_failed", "error": "mark-returned button not found"}

    async def _maybe_fill_notes() -> None:
        if not notes:
            return
        for sel in ['textarea[name="returnNotes"]', 'textarea[placeholder*="note" i]']:
            try:
                handle = page.locator(sel).first
                if await handle.count() > 0 and await handle.is_visible():
                    await handle.fill(notes)
                    return
            except Exception:
                continue

    if not live:
        # Open the modal but don't submit so the operator can see the form.
        try:
            await btn.click()
            await _maybe_fill_notes()
        except Exception:
            pass
        return {"status": "shadow_aborted", "reason": "live=false"}

    async def _submit() -> None:
        await btn.click()
        await _maybe_fill_notes()
        # Look for a Confirm/Save inside the modal.
        for sel in ['button:has-text("Confirm")', 'button:has-text("Save")', 'button:has-text("Submit")']:
            try:
                mb = page.locator(sel).first
                if await mb.count() > 0 and await mb.is_visible():
                    await mb.click()
                    break
            except Exception:
                continue
        await page.wait_for_load_state("networkidle", timeout=10_000)

    return {"status": "shadow_aborted", "submit": _submit}
