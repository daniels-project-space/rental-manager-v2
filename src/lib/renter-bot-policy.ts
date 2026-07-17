/**
 * Separately billed model access is an emergency-only renter-draft fallback.
 * Fail closed unless an operator deliberately opts in with the exact value
 * "true"; unset, mixed-case, and truthy-looking values remain disabled.
 */
export function allowsRenterBotMeteredFallback(value: string | undefined): boolean {
  return value === "true";
}
