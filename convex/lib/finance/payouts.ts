export type Person = "Daniel" | "Leo";
export function pence(value: number) {
  if (!Number.isFinite(value) || Math.abs(value) > 1e9)
    throw Error("Invalid amount");
  return Math.round(value * 100);
}
export function validMonth(month: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw Error("Use YYYY-MM");
}
export function allocate(profit: number, danielBps: number) {
  if (!Number.isInteger(danielBps) || danielBps < 0 || danielBps > 10000)
    throw Error("Invalid split");
  const Daniel = Math.round((profit * danielBps) / 10000);
  return { Daniel, Leo: profit - Daniel };
}
export function balances(
  allocations: { Daniel: number; Leo: number },
  entries: { kind: string; person?: Person; amount: number }[],
) {
  const balance = { ...allocations };
  let cash = allocations.Daniel + allocations.Leo;
  for (const entry of entries) {
    if (!entry.person) continue;
    if (entry.kind === "withdrawal") {
      balance[entry.person] -= entry.amount;
      cash -= entry.amount;
    }
    if (entry.kind === "settlement") {
      balance[entry.person] += entry.amount;
      balance[entry.person === "Leo" ? "Daniel" : "Leo"] -= entry.amount;
    }
  }
  const owedDaniel = Math.min(
    Math.max(-balance.Leo, 0),
    Math.max(balance.Daniel, 0),
  );
  const owedLeo = Math.min(
    Math.max(-balance.Daniel, 0),
    Math.max(balance.Leo, 0),
  );
  return {
    cash,
    balance,
    Daniel: {
      business: Math.max(balance.Daniel, 0) - owedDaniel,
      owed: owedDaniel,
      excess: Math.max(-balance.Daniel, 0),
    },
    Leo: {
      business: Math.max(balance.Leo, 0) - owedLeo,
      owed: owedLeo,
      excess: Math.max(-balance.Leo, 0),
    },
  };
}
