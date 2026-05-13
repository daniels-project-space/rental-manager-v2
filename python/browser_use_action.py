#!/usr/bin/env python3
"""
Wave 4.6 — Hygglo UI action runner.

Entry point invoked by the `hygglo-ui-action` Trigger task via
`python.runScript`. Reads payload + strategy + storage_state path on argv,
restores the Hygglo session, dispatches to a recipe (deterministic
Playwright selectors) or to the AI fallback (`browser_use.Agent` driven
by Grok), then either submits (live mode) or aborts before the final
click (shadow mode — default).

ALL output JSON goes on a single stdout line prefixed `RESULT::`. Anything
else printed is treated as diagnostic noise by the Node wrapper.

Hard contract with the TS task:
  argv[1] = JSON payload     ({accountSlug, action, orderId?, args?, correlationId})
  argv[2] = strategy         ('recipe' | 'ai_first')
  argv[3] = storage_state file path (already written by TS)
  argv[4] = screenshot output dir
  env HYGGLO_UI_SHADOW_MODE  (default 'true')
  env HYGGLO_UI_LIVE_<ACTION> (per-action live override, default unset)
  env XAI_API_KEY            (required for any AI-mode action)
  env XAI_VISION_MODEL       (default 'grok-4.3')
  env XAI_USE_VISION         (default 'true')
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import sys
import time
import traceback
from pathlib import Path
from typing import Any

# ── stdout discipline ──────────────────────────────────────────────────────
# Anything we want the TS wrapper to see goes through `emit_result`.


def emit_result(payload: dict[str, Any]) -> None:
    sys.stdout.write("RESULT::" + json.dumps(payload, default=str) + "\n")
    sys.stdout.flush()


def log(msg: str) -> None:
    sys.stderr.write(f"[browser-use] {msg}\n")
    sys.stderr.flush()


# ── live-mode gate ─────────────────────────────────────────────────────────


def is_live(action: str) -> bool:
    """Per-action live override. Default is shadow."""
    shadow_default = os.environ.get("HYGGLO_UI_SHADOW_MODE", "true").lower() != "false"
    live_flag = os.environ.get(f"HYGGLO_UI_LIVE_{action.upper()}", "false").lower() == "true"
    # live mode requires BOTH: shadow_mode is the master, and per-action flip.
    return (not shadow_default) or live_flag


# ── Recipe registry ────────────────────────────────────────────────────────

RECIPE_ACTIONS = {
    "accept", "decline", "send_message",
    "mark_picked_up", "mark_returned", "leave_review",
    "remove_item",
}

AI_FIRST_ACTIONS = {"add_item", "apply_discount", "change_owner_earnings"}


# ── shared playwright bootstrap ────────────────────────────────────────────


async def make_context(storage_state_path: str):
    from playwright.async_api import async_playwright

    pw = await async_playwright().start()
    browser = await pw.chromium.launch(headless=True, args=["--no-sandbox"])
    context = await browser.new_context(storage_state=storage_state_path)
    page = await context.new_page()
    return pw, browser, context, page


# ── shared assertions ─────────────────────────────────────────────────────


POST_CONDITIONS = {
    "accept": ["Order accepted", "Approved", "Accepted"],
    "decline": ["Declined", "Order declined"],
    "send_message": ["Message sent", "Sent"],
    "mark_picked_up": ["Picked up", "Marked as picked up"],
    "mark_returned": ["Returned", "Marked as returned"],
    "leave_review": ["Review submitted", "Thank you"],
    "remove_item": ["Item removed", "Removed"],
    "add_item": ["Item added", "Added"],
    "apply_discount": ["Updated", "Saved"],
    "change_owner_earnings": ["Updated", "Saved"],
}


async def screenshot_to_b64(page, label: str, screenshot_dir: str) -> tuple[str, str]:
    """Save a screenshot to disk and return (path, base64 jpeg)."""
    Path(screenshot_dir).mkdir(parents=True, exist_ok=True)
    path = os.path.join(screenshot_dir, f"{label}-{int(time.time() * 1000)}.png")
    data = await page.screenshot(path=path, full_page=False)
    return path, base64.b64encode(data).decode("ascii")


async def assert_post(page, action: str) -> str | None:
    """Wait briefly for any acceptable post-condition string."""
    candidates = POST_CONDITIONS.get(action, [])
    if not candidates:
        return None
    deadline = time.time() + 8.0
    while time.time() < deadline:
        try:
            body = (await page.text_content("body")) or ""
        except Exception:
            body = ""
        for c in candidates:
            if c.lower() in body.lower():
                return c
        await asyncio.sleep(0.4)
    return None


# ── Recipe imports ─────────────────────────────────────────────────────────
# Each recipe module exports `async def run(page, payload, *, live: bool)`
# returning `{"status": "submitted" | "shadow_aborted" | "recipe_failed", ...}`.

sys.path.insert(0, os.path.dirname(__file__))
from _action_recipes import resolve as resolve_recipe  # noqa: E402


# ── AI fallback ────────────────────────────────────────────────────────────


def build_ai_task(action: str, payload: dict[str, Any]) -> str:
    """Auto-generate a natural-language task for browser-use Agent."""
    args = payload.get("args") or {}
    order_id = payload.get("orderId")
    if action == "add_item":
        return (
            f"On the Hygglo order page for order {order_id}, click the 'Add item' "
            f"control, type '{args.get('itemName')}' in the autocomplete search box, "
            f"select the first matching listing from my inventory, set quantity to "
            f"{args.get('quantity', 1)} and days to {args.get('days', 1)}, then "
            f"STOP before clicking the final 'Save' or 'Apply' button. Do not submit."
        )
    if action == "apply_discount":
        gbp = args.get("newOwnerEarningsGbp")
        pct = args.get("percentOff")
        if gbp is not None:
            tail = f"set the new value to £{gbp:.2f}"
        else:
            tail = f"reduce the current amount by {pct}%"
        return (
            f"On Hygglo order {order_id}, find the displayed earnings amount "
            f"(usually shown as a £ value the renter would pay or the owner "
            f"would receive). Click that amount to open the inline editor. "
            f"Then {tail}. STOP before clicking the final 'Save' / submit button."
        )
    if action == "change_owner_earnings":
        return (
            f"On Hygglo order {order_id}, locate the 'Owner earnings' or "
            f"'Your share' field. Click it to open the editor. Replace the "
            f"value with £{args.get('newGbp'):.2f}. STOP before submitting."
        )
    # generic fallback for non-AI-first actions when recipe failed
    return f"Perform '{action}' on Hygglo order {order_id} with args {json.dumps(args)}. STOP before final submit."


async def run_ai_fallback(page, action: str, payload: dict[str, Any], live: bool) -> dict[str, Any]:
    """Drive browser-use Agent against the already-loaded page."""
    try:
        from browser_use import Agent
        from browser_use.llm import ChatOpenAI
    except Exception as exc:
        return {
            "status": "ai_unavailable",
            "error": f"browser_use import failed: {exc}",
            "llm_call_count": 0,
        }

    api_key = os.environ.get("XAI_API_KEY")
    if not api_key:
        return {
            "status": "ai_unavailable",
            "error": "XAI_API_KEY not set",
            "llm_call_count": 0,
        }

    model = os.environ.get("XAI_VISION_MODEL", "grok-4.3")
    use_vision = os.environ.get("XAI_USE_VISION", "true").lower() == "true"

    llm = ChatOpenAI(
        model=model,
        base_url="https://api.x.ai/v1",
        api_key=api_key,
    )

    task = build_ai_task(action, payload)
    if not live:
        task += "\n\nIMPORTANT: This is a dry run. Take all preparatory steps but DO NOT click the final submit/save/apply button."

    agent = Agent(
        task=task,
        llm=llm,
        use_vision=use_vision,
        page=page,
        max_actions_per_step=3,
    )

    history = await agent.run(max_steps=15)

    # browser-use reports step + token counts via history.usage()/n_steps
    try:
        llm_calls = len(history.history)
    except Exception:
        llm_calls = 0
    try:
        usage = history.usage()
        in_toks = getattr(usage, "input_tokens", 0)
        out_toks = getattr(usage, "output_tokens", 0)
    except Exception:
        in_toks, out_toks = 0, 0

    return {
        "status": "ai_completed",
        "llm_call_count": llm_calls,
        "input_tokens": in_toks,
        "output_tokens": out_toks,
        "model": model,
        "use_vision": use_vision,
    }


# ── main dispatcher ────────────────────────────────────────────────────────


async def main() -> None:
    if len(sys.argv) < 5:
        emit_result({"ok": False, "error": "argv layout mismatch (need payload,strategy,storage,screenshotDir)"})
        return

    payload_str, strategy, storage_state_path, screenshot_dir = sys.argv[1:5]
    try:
        payload = json.loads(payload_str)
    except Exception as exc:
        emit_result({"ok": False, "error": f"payload parse failed: {exc}"})
        return

    action = payload.get("action") or ""
    correlation = payload.get("correlationId") or ""
    live = is_live(action)
    log(f"action={action} strategy={strategy} live={live} cid={correlation}")

    pw = browser = context = page = None
    result: dict[str, Any] = {
        "ok": False,
        "action": action,
        "correlationId": correlation,
        "live": live,
        "strategyAttempted": strategy,
        "strategyUsed": None,
        "llm_call_count": 0,
        "input_tokens": 0,
        "output_tokens": 0,
    }

    try:
        pw, browser, context, page = await make_context(storage_state_path)

        # Navigate to the order page when applicable.
        order_id = payload.get("orderId")
        if order_id:
            order_url = f"https://www.hygglo.co.uk/profile/my_orders/{order_id}"
            await page.goto(order_url, wait_until="domcontentloaded", timeout=30_000)

        recipe_result: dict[str, Any] | None = None
        ai_result: dict[str, Any] | None = None

        if strategy == "recipe" and action in RECIPE_ACTIONS:
            recipe = resolve_recipe(action)
            if recipe is not None:
                try:
                    recipe_result = await recipe(page, payload, live=live)
                except Exception as rexc:
                    recipe_result = {
                        "status": "recipe_failed",
                        "error": f"{type(rexc).__name__}: {rexc}",
                    }

            if recipe_result and recipe_result.get("status") in ("submitted", "shadow_aborted"):
                result["strategyUsed"] = "recipe"
            else:
                # fall through to AI
                ai_result = await run_ai_fallback(page, action, payload, live)
                result["strategyUsed"] = "ai_fallback"
        else:
            # ai_first path (or unknown action)
            ai_result = await run_ai_fallback(page, action, payload, live)
            result["strategyUsed"] = "ai_first"

        # Bookkeeping for AI mode
        if ai_result:
            result["llm_call_count"] = ai_result.get("llm_call_count", 0)
            result["input_tokens"] = ai_result.get("input_tokens", 0)
            result["output_tokens"] = ai_result.get("output_tokens", 0)
            if ai_result.get("status") == "ai_unavailable":
                result["ok"] = False
                result["error"] = ai_result.get("error")
                _, b64 = await screenshot_to_b64(page, f"{action}-ai-failed", screenshot_dir)
                result["screenshotB64"] = b64
                emit_result(result)
                return

        # Pre-submit screenshot (always, for shadow audit trail).
        pre_path, pre_b64 = await screenshot_to_b64(page, f"{action}-pre", screenshot_dir)
        result["screenshotB64"] = pre_b64
        result["screenshotLocalPath"] = pre_path

        if not live:
            result["ok"] = True
            result["mode"] = "shadow"
            result["confirmationText"] = None
            emit_result(result)
            return

        # LIVE: if recipe stopped at submit guard (status=shadow_aborted), we
        # explicitly re-invoke its submit() step now. For AI mode the agent
        # was instructed to stop before submit — we don't have a separate
        # submit hook today, so live AI submits are NOT YET supported.
        if result["strategyUsed"] == "recipe" and recipe_result and recipe_result.get("submit"):
            try:
                await recipe_result["submit"]()
            except Exception as sexc:
                result["ok"] = False
                result["error"] = f"submit-step failed: {sexc}"
                emit_result(result)
                return

        confirmation = await assert_post(page, action)
        result["confirmationText"] = confirmation
        result["ok"] = confirmation is not None
        result["mode"] = "live"
        post_path, post_b64 = await screenshot_to_b64(page, f"{action}-post", screenshot_dir)
        result["postScreenshotB64"] = post_b64
        result["postScreenshotLocalPath"] = post_path
        emit_result(result)
    except Exception as exc:
        log("FATAL: " + traceback.format_exc())
        result["ok"] = False
        result["error"] = f"{type(exc).__name__}: {exc}"
        try:
            if page is not None:
                _, b64 = await screenshot_to_b64(page, f"{action}-error", screenshot_dir)
                result["screenshotB64"] = b64
        except Exception:
            pass
        emit_result(result)
    finally:
        try:
            if context is not None:
                await context.close()
            if browser is not None:
                await browser.close()
            if pw is not None:
                await pw.stop()
        except Exception:
            pass


if __name__ == "__main__":
    asyncio.run(main())
