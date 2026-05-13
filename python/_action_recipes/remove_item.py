"""Recipe: remove an item line from an order. Per-row delete icon."""
from typing import Any


async def run(page, payload: dict[str, Any], *, live: bool) -> dict[str, Any]:
    item_name = ((payload.get("args") or {}).get("itemName") or "").strip()
    if not item_name:
        return {"status": "recipe_failed", "error": "args.itemName missing"}

    # Find the row containing the item, then the delete icon within it.
    row_candidates = [
        f'[data-testid="order-item-row"]:has-text("{item_name}")',
        f'tr:has-text("{item_name}")',
        f'li:has-text("{item_name}")',
    ]
    row = None
    for sel in row_candidates:
        try:
            handle = page.locator(sel).first
            if await handle.count() > 0:
                row = handle
                break
        except Exception:
            continue
    if row is None:
        return {"status": "recipe_failed", "error": f"row for '{item_name}' not found"}

    delete_candidates = [
        '[data-testid="remove-item"]',
        'button[aria-label="Remove"]',
        'button[aria-label="Delete"]',
        'button:has-text("Remove")',
    ]
    btn = None
    for sel in delete_candidates:
        try:
            handle = row.locator(sel).first
            if await handle.count() > 0:
                btn = handle
                break
        except Exception:
            continue
    if btn is None:
        return {"status": "recipe_failed", "error": "delete icon not found within row"}

    if not live:
        return {"status": "shadow_aborted", "reason": "live=false"}

    async def _submit() -> None:
        await btn.click()
        # Confirm modal if any.
        for sel in ['button:has-text("Confirm")', 'button:has-text("Yes")', 'button:has-text("Remove")']:
            try:
                cb = page.locator(sel).first
                if await cb.count() > 0 and await cb.is_visible():
                    await cb.click()
                    break
            except Exception:
                continue
        await page.wait_for_load_state("networkidle", timeout=10_000)

    return {"status": "shadow_aborted", "submit": _submit}
