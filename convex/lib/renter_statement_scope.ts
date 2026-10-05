/** Mask verification questions, preserving offsets and separate assertions. */
export function withoutVerificationQuestions(text: string): string {
  return text.replace(/\b(?:check|verify|confirm|find\s+out)\s+(?:whether|if)\b[^,;.!?\n]*?(?=\s+\b(?:but|however|whereas|while|and\s+(?:(?:your|the|this|that|our)\s+)?(?:kit|set|camera|body)\s+(?:includes?|comes|is|has))\b|[,;.!?\n]|$)/gi,
    part => " ".repeat(part.length));
}

/** A fronted nonfinite modifier belongs to its following main clause. */
export function equipmentClaimClauses(text: string, namesSubject: (part: string) => boolean): string[] {
  return text.replace(/’/g, "'").split(/(?<=[.!?])\s+|\n+|;|\b(?:but|while|whereas)\b/i).flatMap(sentence => {
    const clauses = sentence.split(",");
    if (clauses.length > 1 && /^\s*(?:as|with|for)\b/i.test(clauses[0])
      && !namesSubject(clauses[0])
      && !/\b(?:is|are|has|have|does|can|cannot|can't|isn't|aren't)\b/i.test(clauses[0])) {
      clauses.splice(0, 2, `${clauses[0]},${clauses[1]}`);
    }
    return clauses;
  });
}
