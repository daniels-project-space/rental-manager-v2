/** Shared definition of a review required for the final Lab reply. Raw model
 * issues corrected by the production guard remain in run evidence, but they do
 * not mean the accepted draft still needs a person to fix it. */
export function renterBotNeedsHumanReview(
  rubricResults: unknown,
  productionGuardFlags: unknown,
): boolean {
  const hasUnresolvedRubricFlag = Array.isArray(rubricResults) && rubricResults.some((row) => {
    if (!row || typeof row !== "object") return false;
    const result = row as { status?: unknown; category?: unknown };
    return result.status === "flag" &&
      !(typeof result.category === "string" && result.category.startsWith("production_guard:"));
  });
  const hasUnresolvedGuardFlag = Array.isArray(productionGuardFlags) && productionGuardFlags.some((row) =>
    !!row && typeof row === "object" && (row as { action?: unknown }).action === "flagged",
  );
  return hasUnresolvedRubricFlag || hasUnresolvedGuardFlag;
}
