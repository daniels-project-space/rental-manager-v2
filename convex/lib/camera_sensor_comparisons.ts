/** Reviewed relationships, independent of SEO titles and rental ownership.
 * Equal sensor format/resolution alone never establishes sensor identity. */
export const verifiedSensorComparisons = [{
  models: ["Sony FX3", "Sony A7S III"],
  relation: "same_sensor" as const,
  source_url: "https://sony-cinematography.com/articles/the-sony-fx3---what-s-it-all-about--a-brief-review-by-alister-chapman/",
  verified_at: 1790899200000,
}];

function modelIds(text: string) {
  return [...text.matchAll(/\b(?:(?:Sony\s+)?(?:FX\s*\d+|A7\s*[SRC]?\s*(?:III|II|IV|V|\d+)|A7CR|A6\d{3}|ZV[ -]?E\d+)|Sony\s+(?:Alpha\s+)?[A-Z]+\s*\d+[A-Z]*|Canon\s+(?:EOS\s+)?[CR]\d+|Nikon\s+Z\d+|(?:BMPCC|Blackmagic)\s+\d+K(?:\s+(?:Pro|Full Frame))?|Pyxis|Komodo|ARRI)\b/gi)]
    .map(m => m[0].toLowerCase().replace(/^sony\s+/, "").replace(/\s+/g, "")
      .replace(/iii$/, "3").replace(/ii$/, "2").replace(/iv$/, "4").replace(/v$/, "5"));
}

const sensorWords = String.raw`(?:(?:\d+(?:\.\d+)?\s*MP|full[ -]?frame|image|imaging|CMOS|BSI|Exmor\s+R|back[ -]?illuminated|stacked)\s+)*`;
const sensorIdentityClaim = new RegExp(String.raw`\b(?:same|identical)\s+${sensorWords}sensors?\b|\bshares?\s+(?:(?:its|the|a)\s+)?${sensorWords}sensors?\s+with\b|\buses?\s+(?:the\s+)?[^,;.!?]{1,45}'s\s+${sensorWords}sensor\b`, "i");

/** Named objects replace the current subject; a single new model can compare
 * to the previous subject. A generic comparison needs an unambiguous pair.
 * Neither marketing eligibility nor common mount is proof of sensor identity. */
export function unsupportedSensorIdentityClaims(text: string, initialNames: string[] = []) {
  const failures: string[] = [];
  let subjects = [...new Set(initialNames.flatMap(modelIds))];
  for (const clause of text.replace(/’/g, "'").split(/(?<=[.!?])\s+|\n+|[,;]|\b(?:but|whereas|while)\b/i)) {
    const named = [...new Set(modelIds(clause))];
    if (named.length >= 2) subjects = named;
    else if (named.length === 1) subjects = [...subjects.filter(n => n !== named[0]).slice(-1), named[0]];
    const claim = sensorIdentityClaim.exec(clause);
    if (!claim || /^\s*(?:size|format|dimensions?|resolution|type)\b/i.test(clause.slice(claim.index + claim[0].length))) continue;
    const prefix = clause.slice(0, claim.index);
    const negatesComparison = /\b(?:no|not|without|don't|doesn't|do not|does not|isn't|aren't|can't|cannot)\s+(?:(?:have|has|use|uses|share|shares|using|sharing|exactly|precisely|necessarily|the|a|an)\s+)*$/i.test(prefix);
    const conditionalComparison = /\b(?:if|whether)\b[^,;.!?]{0,90}$/i.test(prefix);
    if (negatesComparison || conditionalComparison || /\?\s*$/.test(clause)) continue;
    const supported = subjects.length === 2 && verifiedSensorComparisons.some(c => {
      const pair = c.models.flatMap(modelIds);
      return subjects.every(s => pair.includes(s));
    });
    if (!supported) failures.push(clause.trim());
  }
  return failures;
}

export function sensorComparisonInstruction() {
  return `CAMERA COMPARISON SOURCE POLICY: advertising titles, price names and shared sensor format/resolution do not establish identical sensors or interchangeable cameras. Reviewed sensor relationships: ${JSON.stringify(verifiedSensorComparisons)}. Use only the exact reviewed pair for a same-sensor claim; this does not establish identical controls, cooling, firmware, recording modes or supplied accessories. Other comparisons require their own reviewed facts.`;
}
