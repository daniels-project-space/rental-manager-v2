/** Conservative extraction: absent or conflicting amounts remain unknown. All values are pence. */
export function invoiceAmounts(text: string) {
  const amount = (label: string) => {
    const matches = [
      ...text.matchAll(
        new RegExp(
          label +
            "[ \\t]*(?:£|GBP)?[ \\t]*(-?[\\d,]+\\.\\d{2})(?=[ \\t\\r\\n]|$)",
          "gi",
        ),
      ),
    ];
    const values = [
      ...new Set(
        matches.map((m) => Math.round(Number(m[1].replaceAll(",", "")) * 100)),
      ),
    ];
    return values.length === 1 ? values[0] : undefined;
  };
  const revenue = amount("Order value incl\\.? VAT");
  const commission = amount("Commission incl\\.? VAT");
  const payout = amount("Net payout");
  const lender_fee =
    commission === undefined ? undefined : Math.abs(commission);
  const renter_fee = amount(
    "(?:Borrower|Renter) (?:service )?fee(?: incl\\.? VAT)?",
  );
  const currency = /£|GBP|GB\d{9}|Hygglo Ltd/i.test(text) ? "GBP" : "UNKNOWN";
  const reconciles =
    revenue !== undefined &&
    lender_fee !== undefined &&
    payout !== undefined &&
    revenue - lender_fee === payout;
  return {
    amounts: {
      ...(revenue === undefined ? {} : { revenue }),
      ...(lender_fee === undefined ? {} : { lender_fee }),
      ...(renter_fee === undefined ? {} : { renter_fee }),
      ...(payout === undefined ? {} : { payout }),
      currency,
    },
    verified: reconciles && currency === "GBP",
  };
}
