/** A workflow's active step is the next action, not proof of completion. */
export function providerReturnCompleted(order: unknown): boolean {
  if (!order || typeof order !== "object") return false;
  const o = order as {
    steps?: unknown;
    detail?: { steps?: unknown };
    _detail?: { steps?: unknown };
  };
  const steps = o.steps ?? o.detail?.steps ?? o._detail?.steps;
  return (
    Array.isArray(steps) &&
    steps.some(
      (step) =>
        step &&
        typeof step === "object" &&
        step.key === "RETURNED" &&
        step.completed === true &&
        step.failure !== true,
    )
  );
}
