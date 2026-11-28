const CROSS_ACCOUNT_REFERENCE = /\b(?:other listings? across (?:the )?accounts?|(?:other|different|multiple|several) accounts?|across (?:the )?accounts?|shared (?:stock|inventory|ownership)|(?:Leo|Diogo|dbcinema)\s+(?:also\s+)?(?:has|have|owns|runs|is|are)\s+(?:another|the same|a different) account)\b/i;

/** Sentences that disclose or imply separate rental accounts share inventory or ownership. */
export function crossAccountReferenceSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).filter((sentence) => CROSS_ACCOUNT_REFERENCE.test(sentence));
}

export function containsCrossAccountReference(text: string): boolean {
  return crossAccountReferenceSentences(text).length > 0;
}

/** Remove account-linking explanations while preserving independently useful sentences. */
export function stripCrossAccountReferenceSentences(text: string): { text: string; removed: boolean } {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const kept = sentences.filter((sentence) => !CROSS_ACCOUNT_REFERENCE.test(sentence));
  return { text: kept.join(" ").replace(/\s{2,}/g, " ").trim(), removed: kept.length !== sentences.length };
}
