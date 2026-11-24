/** A workflow's active step is the next action, not proof of completion. */
export function providerReturnCompleted(order: unknown): boolean {
  if (!order || typeof order !== "object") return false;
  const o = order as {
    steps?: unknown;
    detail?: { steps?: unknown };
    _detail?: { steps?: unknown };
  };
  const steps = o.steps ?? o.detail?.steps ?? o._detail?.steps;
  if (!Array.isArray(steps)) return false;
  const returned = steps.filter(
    (step) => step && typeof step === "object" && step.key === "RETURNED",
  );
  return (
    returned.length === 1 &&
    returned[0].completed === true &&
    (returned[0].failure === false || returned[0].failure === undefined)
  );
}

export function providerActiveStep(order: unknown): string | undefined {
  if (!order || typeof order !== "object") return undefined;
  const record = order as { steps?: unknown; detail?: { steps?: unknown }; _detail?: { steps?: unknown } };
  const steps = record.steps ?? record.detail?.steps ?? record._detail?.steps;
  if (!Array.isArray(steps)) return undefined;
  if (providerReturnCompleted(order)) return "REVIEWED";
  const active = steps.find((step) => step && typeof step === "object" && step.active === true);
  return typeof active?.key === "string" && active.key !== "REVIEWED" ? active.key : undefined;
}
