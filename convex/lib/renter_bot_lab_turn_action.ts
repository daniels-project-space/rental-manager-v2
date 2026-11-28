export type ReferralRestoreTurnAction = {
  request_message_id: string;
  referral_code: string;
  start_date: string;
  end_date: string;
  items: Array<{ product_id: number; qty: number }>;
};

/** Stable idempotency key for one friend's exact basket restore on one renter turn. */
export function referralRestoreTurnKey(action: ReferralRestoreTurnAction): string {
  const items = [...action.items]
    .map(({ product_id, qty }) => ({ product_id, qty }))
    .sort((a, b) => a.product_id - b.product_id);
  return JSON.stringify([
    action.request_message_id,
    "restore_referral_basket",
    action.referral_code,
    action.start_date,
    action.end_date,
    items,
  ]);
}

/** Parse only a well-formed restore receipt for this exact renter message. */
export function parseReferralRestoreTurnKey(value: unknown, requestMessageId: string): ReferralRestoreTurnAction | null {
  if (typeof value !== "string" || !requestMessageId) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length !== 6 || parsed[0] !== requestMessageId ||
      parsed[1] !== "restore_referral_basket" || typeof parsed[2] !== "string" || !parsed[2] ||
      typeof parsed[3] !== "string" || typeof parsed[4] !== "string" || !Array.isArray(parsed[5]) ||
      !parsed[5].length || parsed[5].length > 8) return null;
    const items: Array<{ product_id: number; qty: number }> = [];
    for (const raw of parsed[5]) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
      const line = raw as Record<string, unknown>;
      if (!Number.isInteger(line.product_id) || (line.product_id as number) < 1 ||
        !Number.isInteger(line.qty) || (line.qty as number) < 1 || (line.qty as number) > 20) return null;
      items.push({ product_id: line.product_id as number, qty: line.qty as number });
    }
    if (new Set(items.map(item => item.product_id)).size !== items.length) return null;
    return {
      request_message_id: requestMessageId,
      referral_code: parsed[2],
      start_date: parsed[3],
      end_date: parsed[4],
      items: items.sort((a, b) => a.product_id - b.product_id),
    };
  } catch {
    return null;
  }
}

export function verifiedReferralRestoreReplay(input: {
  change_key: unknown;
  request_message_id: string;
  latest_renter_message_id?: string;
  thread_id: string;
  account_slug: string;
  start_date?: string;
  end_date?: string;
  order_items: Array<{ product_id?: number; qty: number }>;
  redeemed_by?: string;
  referral_account_slug?: string;
}) {
  if (!input.request_message_id || input.latest_renter_message_id !== input.request_message_id ||
    !input.thread_id.startsWith("__probe__")) return null;
  const action = parseReferralRestoreTurnKey(input.change_key, input.request_message_id);
  if (!action || input.start_date !== action.start_date || input.end_date !== action.end_date ||
    input.redeemed_by !== input.thread_id || input.referral_account_slug !== input.account_slug) return null;
  const actual = input.order_items.every(line => Number.isInteger(line.product_id) && Number.isInteger(line.qty))
    ? input.order_items.map(line => ({ product_id: line.product_id!, qty: line.qty })).sort((a, b) => a.product_id - b.product_id)
    : [];
  if (JSON.stringify(actual) !== JSON.stringify(action.items)) return null;
  return {
    source: "native_lab_amendment" as const,
    action: "restore_referral_basket" as const,
    thread_id: input.thread_id,
    account_slug: input.account_slug,
    request_message_id: input.request_message_id,
    start_date: action.start_date,
    end_date: action.end_date,
    items: action.items,
  };
}
