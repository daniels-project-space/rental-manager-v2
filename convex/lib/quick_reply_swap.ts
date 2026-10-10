export type SwapResult = {
  ok: boolean;
  state: "applied" | "failed" | "attention";
  message?: string;
};
/** Hygglo has no atomic swap. Never remove the original before proving the new line exists. */
export async function executeNativeSwap(
  io: {
    read: () => Promise<any>;
    add: () => Promise<any>;
    remove: (id: number) => Promise<any>;
  },
  oldId: number,
  newProductId: number,
): Promise<SwapResult> {
  const before = await io.read();
  const old = before.items?.find((i: any) => i.item_id === oldId);
  if (
    !before.ok ||
    !old?.can_remove ||
    !before.actions?.add_product ||
    before.items.some((i: any) => i.product_id === newProductId)
  )
    return {
      ok: false,
      state: "failed",
      message: "The order changed or no longer allows this replacement.",
    };
  const ids = new Set(before.items.map((i: any) => i.item_id));
  let added: any;
  try {
    added = await io.add();
  } catch {
    return {
      ok: false,
      state: "attention",
      message:
        "The add result is unknown. Check the order on Hygglo before another change.",
    };
  }
  if (added.status !== "sent")
    return {
      ok: false,
      state: added.status === "failed" ? "attention" : "failed",
      message: "Hygglo did not confirm the replacement addition.",
    };
  let after: any;
  try {
    after = await io.read();
  } catch {
    return {
      ok: false,
      state: "attention",
      message: "Could not verify the added item. Original kit was kept.",
    };
  }
  const addedLines =
    after.items?.filter(
      (i: any) => i.product_id === newProductId && !ids.has(i.item_id),
    ) ?? [];
  if (
    !after.ok ||
    addedLines.length !== 1 ||
    !Number.isSafeInteger(addedLines[0].item_id) ||
    !after.items.some((i: any) => i.item_id === oldId)
  )
    return {
      ok: false,
      state: "attention",
      message:
        "The order needs an operator check. No original item was removed.",
    };
  let removed: any;
  try {
    removed = await io.remove(oldId);
  } catch {
    return {
      ok: false,
      state: "attention",
      message: "The removal result is unknown. Check both items on Hygglo.",
    };
  }
  if (removed.status !== "sent") {
    // Only compensate the exact line created by this call; never a pre-existing product.
    if (removed.status === "failed")
      return {
        ok: false,
        state: "attention",
        message:
          "Removal result is uncertain. Check the order before further changes.",
      };
    try {
      const rollback = await io.remove(addedLines[0].item_id);
      return {
        ok: false,
        state: rollback.status === "sent" ? "failed" : "attention",
        message:
          "The original item was kept; the replacement could not be applied.",
      };
    } catch {
      return {
        ok: false,
        state: "attention",
        message: "Check both items on Hygglo; recovery could not be confirmed.",
      };
    }
  }
  try {
    const final = await io.read();
    if (
      final.ok &&
      !final.items.some((i: any) => i.item_id === oldId) &&
      final.items.some((i: any) => i.item_id === addedLines[0].item_id)
    )
      return { ok: true, state: "applied" };
  } catch {}
  return {
    ok: false,
    state: "attention",
    message:
      "Check the final kit on Hygglo; the replacement could not be verified.",
  };
}

/** Snapshot order is independent of JSON transport property ordering. */
export function nativeSwapSnapshot(original: any, replacementId: string) {
  return JSON.stringify([
    original.account_slug,
    original.item_id ?? null,
    original.product_id ?? null,
    original.name,
    original.start ?? null,
    original.end ?? null,
    replacementId,
  ]);
}
export function websiteSwapSnapshot(original: any) {
  return JSON.stringify([
    original.lineIndex,
    original.listingId,
    original.qty,
    original.start,
    original.end,
  ]);
}
