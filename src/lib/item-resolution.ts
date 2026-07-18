const GEAR_TERM =
  String.raw`(?:camera|body|lens|tripod|gimbal|mic(?:rophone)?|monitor|recorder|light|speaker|battery|filter|drone|adapter|\d{1,3}\s*mm)`;
const GEAR_AMPERSAND_RE = new RegExp(
  String.raw`\b${GEAR_TERM}\b[^&]{0,40}&[^&]{0,40}\b${GEAR_TERM}\b`,
  "i",
);

/**
 * True when one marketplace title likely represents multiple physical items.
 * A bare ampersand is not enough: SEO copy such as "Video & Photography"
 * describes one product and previously forced obvious single-item listings
 * onto the LLM-only kit path.
 */
export function isLikelyMultiItemListing(title: string): boolean {
  return (
    /\+|\b(kit|bundle|combo|set)\b|(?:^|[\s(|])\d+\s*(?:x\b|×)/i.test(title) ||
    GEAR_AMPERSAND_RE.test(title)
  );
}

/**
 * Break a genuine multi-item listing into matchable product phrases.
 * Comparison-only models are removed so they cannot become false inventory
 * matches. Generic descriptor fragments are harmless: the matcher rejects
 * fragments without specific product evidence.
 */
export function listingResolutionSegments(title: string): string[] {
  const withoutComparisons = title
    .replace(/\((?:like|similar\s+to|same\s+sensor\s+as)[^)]*\)/gi, " ")
    .replace(/\s+compatible\s+with\b.*$/i, " ");
  const segments = withoutComparisons
    .split(/\s+\+\s+|\s+\|\s+|[\n;]+/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  return segments.length > 0 ? segments : [title.trim()];
}
