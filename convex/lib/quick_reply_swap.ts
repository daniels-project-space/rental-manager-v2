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

export function basketSwapSnapshot(original: any, replacementId: string) {
  return JSON.stringify([
    original.account_slug ?? null,
    original.start ?? null,
    original.end ?? null,
    (original.items ?? []).map((line: any) => [
      line.item_id ?? null,
      line.product_id ?? null,
      line.name,
      line.qty ?? 1,
    ]),
    (original.lines ?? []).map((line: any) => [
      line.lineIndex,
      line.listingId,
      line.qty,
      line.start,
      line.end,
    ]),
    replacementId,
  ]);
}
/** Add and prove the entire replacement set before removing any original.
 * Ambiguous provider results stop immediately and are never automatically retried. */
export async function executeNativeBasketSwap(
  io: {
    read: () => Promise<any>;
    add: (productId: number) => Promise<any>;
    remove: (itemId: number) => Promise<any>;
  },
  swaps: { oldId: number; newProductId: number }[],
  expected: any,
): Promise<SwapResult> {
  const attention = (message: string): SwapResult => ({
    ok: false,
    state: "attention",
    message,
  });
  const before = await io.read();
  const snapshot = (state: any) =>
    basketSwapSnapshot(
      {
        account_slug: expected.account_slug,
        start: state.dates?.start,
        end: state.dates?.end,
        items: state.items,
      },
      "",
    );
  if (
    !before.ok ||
    !before.actions?.add_product ||
    snapshot(before) !== basketSwapSnapshot(expected, "") ||
    !swaps.length ||
    new Set(swaps.map((s) => s.oldId)).size !== swaps.length ||
    new Set(swaps.map((s) => s.newProductId)).size !== swaps.length ||
    swaps.some(
      (s) =>
        !before.items.some(
          (line: any) => line.item_id === s.oldId && line.can_remove,
        ) ||
        before.items.some((line: any) => line.product_id === s.newProductId),
    )
  )
    return {
      ok: false,
      state: "failed",
      message: "The rental changed. Refresh the replacement set.",
    };
  const originalIds = new Set(before.items.map((line: any) => line.item_id));
  const addedIds: number[] = [];
  for (const swap of swaps) {
    let result: any;
    try {
      result = await io.add(swap.newProductId);
    } catch {
      return attention(
        "Addition result is uncertain. Original kit was kept; check the order before another change.",
      );
    }
    if (result.status !== "sent") {
      if (result.status === "failed")
        return attention(
          "Addition result is uncertain. Check the order before another change.",
        );
      // A definitive skipped addition permits recovery of only our proven additions.
      for (const id of addedIds) {
        try {
          if ((await io.remove(id)).status !== "sent")
            return attention(
              "Original kit was kept. Check the incomplete replacement set on Hygglo.",
            );
        } catch {
          return attention("Recovery could not be verified. Check the order.");
        }
      }
      return {
        ok: false,
        state: "failed",
        message:
          "The replacement set could not be added. Original kit was kept.",
      };
    }
    let after: any;
    try {
      after = await io.read();
    } catch {
      return attention("Could not verify the addition. Original kit was kept.");
    }
    const lines =
      after.items?.filter(
        (line: any) =>
          line.product_id === swap.newProductId &&
          !originalIds.has(line.item_id),
      ) ?? [];
    if (
      !after.ok ||
      lines.length !== 1 ||
      !Number.isSafeInteger(lines[0].item_id) ||
      before.items.some(
        (old: any) =>
          !after.items.some((line: any) => line.item_id === old.item_id),
      ) ||
      addedIds.some(
        (id) => !after.items.some((line: any) => line.item_id === id),
      )
    )
      return attention(
        "The order changed during replacement. No original was removed by this operation.",
      );
    addedIds.push(lines[0].item_id);
  }
  // Re-read every required line before beginning the irreversible remove phase.
  let ready: any;
  try {
    ready = await io.read();
  } catch {
    return attention(
      "Could not verify the complete set. Original kit was kept.",
    );
  }
  if (
    !ready.ok ||
    swaps.some(
      (s) =>
        !ready.items.some(
          (line: any) => line.item_id === s.oldId && line.can_remove,
        ),
    ) ||
    addedIds.some((id) => !ready.items.some((line: any) => line.item_id === id))
  )
    return attention("The complete set changed. Original kit was kept.");
  for (const swap of swaps) {
    try {
      if ((await io.remove(swap.oldId)).status !== "sent")
        return attention(
          "The set was added but original removal was not confirmed. Check the order before another change.",
        );
    } catch {
      return attention(
        "Removal result is uncertain. Check the complete order on Hygglo.",
      );
    }
  }
  try {
    const final = await io.read();
    if (
      final.ok &&
      swaps.every(
        (s) => !final.items.some((line: any) => line.item_id === s.oldId),
      ) &&
      addedIds.every((id) =>
        final.items.some((line: any) => line.item_id === id),
      ) &&
      before.items
        .filter((line: any) => !swaps.some((s) => s.oldId === line.item_id))
        .every((old: any) =>
          final.items.some((line: any) => line.item_id === old.item_id),
        )
    )
      return { ok: true, state: "applied" };
  } catch {}
  return attention(
    "The final kit could not be verified. Check the order on Hygglo.",
  );
}
