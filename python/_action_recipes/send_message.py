"""Recipe: send chat message. Wave 4.5 already covers this via REST; UI is fallback."""
from typing import Any


async def run(page, payload: dict[str, Any], *, live: bool) -> dict[str, Any]:
    text = (payload.get("args") or {}).get("text") or ""
    if not text:
        return {"status": "recipe_failed", "error": "args.text empty"}

    candidates_box = [
        '[data-testid="chat-message-input"]',
        'textarea[name="message"]',
        'textarea[placeholder*="message" i]',
        'textarea',
    ]
    box = None
    for sel in candidates_box:
        try:
            handle = page.locator(sel).first
            if await handle.count() > 0 and await handle.is_visible():
                box = handle
                break
        except Exception:
            continue
    if box is None:
        return {"status": "recipe_failed", "error": "chat textarea not found"}

    await box.fill(text)

    candidates_btn = [
        '[data-testid="chat-send-button"]',
        'button[aria-label="Send"]',
        'button:has-text("Send")',
    ]
    btn = None
    for sel in candidates_btn:
        try:
            handle = page.locator(sel).first
            if await handle.count() > 0 and await handle.is_visible():
                btn = handle
                break
        except Exception:
            continue
    if btn is None:
        return {"status": "recipe_failed", "error": "send button not found"}

    if not live:
        return {"status": "shadow_aborted", "reason": "live=false"}

    async def _submit() -> None:
        await btn.click()
        await page.wait_for_load_state("networkidle", timeout=10_000)

    return {"status": "shadow_aborted", "submit": _submit}
