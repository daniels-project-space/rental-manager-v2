"""
Wave 4.6 — Hygglo UI recipe registry.

`resolve(action)` returns the `async run(page, payload, *, live)` callable
for a stable-selector recipe, or None to force AI mode. The runner in
`browser_use_action.py` falls through to AI on `recipe_failed` status.

Each recipe MUST:
  1. Use 2-3 selector fallbacks (test_id -> aria-label -> text).
  2. Stop before the final submit when `live` is False (shadow mode).
  3. Return {"status": "submitted"|"shadow_aborted"|"recipe_failed", ...}
  4. On `shadow_aborted` for live=True, attach a `"submit"` async callable
     so the runner can perform the actual click after capturing pre-state.
"""

from typing import Any, Awaitable, Callable, Optional

from . import accept as _accept
from . import decline as _decline
from . import send_message as _send_message
from . import mark_picked_up as _mark_picked_up
from . import mark_returned as _mark_returned
from . import leave_review as _leave_review
from . import remove_item as _remove_item

RecipeFn = Callable[[Any, dict[str, Any]], Awaitable[dict[str, Any]]]

_REGISTRY: dict[str, RecipeFn] = {
    "accept": _accept.run,
    "decline": _decline.run,
    "send_message": _send_message.run,
    "mark_picked_up": _mark_picked_up.run,
    "mark_returned": _mark_returned.run,
    "leave_review": _leave_review.run,
    "remove_item": _remove_item.run,
}


def resolve(action: str) -> Optional[RecipeFn]:
    return _REGISTRY.get(action)
