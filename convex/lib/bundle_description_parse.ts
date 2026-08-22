/**
 * Pure parser for "what's in this kit" listing descriptions.
 *
 * Split out of propose_bundle_mapping.ts so it can be unit-tested without the
 * Convex runtime. Every rule here was added in response to a REAL listing that
 * produced a wrong mapping -- see bundle_description_parse.test.ts, which
 * feeds the actual description text that caused each failure.
 */
/** Consumables/packaging that are not separately-tracked inventory. */
/**
 * A line that quotes a per-day price, or asks to add/upgrade, is an OFFER --
 * not part of the rental. Belt-and-braces alongside the section cut above:
 * even if a listing invents a new heading, an individually-priced line is
 * never an inclusion.
 */
const ADDON_RE =
  /\d\s*\/\s*day|\bcan be added\b|\bis available for\b|\bavailable for\b|\badd my\b|\badd an?\b|\badd \d\b|\bupgrade\b|\bfor an additional\b|\bextra\b/i;

const NOISE_RE =
  /^(various|needed|cables?|carrying|carry|bag|bags|case|cases|packaged|all items|charger|chargers|cable)\b/i;

/** Pull the component list out of an "Included in this rental" style block. */
export function extractComponents(desc: string): {
  components: Array<{ qty: number; name: string }>;
  usedBullets: boolean;
} {
  const clean = desc.replace(/[^\x20-\x7E]/g, " ").replace(/\s+/g, " ");
  // Where does the component list actually start? Owners phrase this several
  // ways. Missing the marker leaves the marketing intro in the list, and an
  // intro sentence parsed as a component is how "I'm offering a
  // comprehensive, ready-to-shoot cinema kit" became a PL-to-EF mount.
  const START_RE =
    /(?:included in th(?:is|e)[^:]*|in th(?:is|e) (?:kit|rental|bundle|package)|(?:what(?:'|)s|whats) included|(?:this |the )?(?:kit|package|bundle|rental) includes|you (?:get|receive)|contents)\s*:?(.*)$/i;
  const m = clean.match(START_RE);
  let body = m ? m[1] : clean;
  // Everything after "About this ..." is marketing prose, not contents.
  body = body.split(
    /\bAbout th(?:is|e)\b|\bA quick note\b|\bPlease note\b|\bI do my best\b|\busually available\b/i,
  )[0];
  // STOP AT THE ADD-ON SECTION. Several listings follow the kit list with a
  // long menu of PAID extras ("Direct Add-on Upgrades:", "ADD-ONS"). Those are
  // not in the rental. diogo#1173566 is a 3-item kit followed by 25 add-on
  // lines; parsing them as included produced "2x DJI RS3 Pro gimbal" (one in
  // the kit, one offered "for 25/day") plus a drone kit, two mic systems and
  // two filters. Writing that would hold ~9 items on every rental of a £55
  // listing -- gear shown as rented while it sits on the shelf, which is the
  // false-unavailability failure this work exists to eliminate.
  body = body.split(
    /\bDirect Add-?on\b|\bAdd-?ons?\s*:|\bADD-?ONS\b|\bOptional (?:extras?|add-?ons?|upgrades?)\b|\bUpgrades?\s*:|\bI also have\b/i,
  )[0];
  // Section labels ("Camera:", "Lenses (Anamorphic):", "Media:") are headings.
  body = body.replace(/\b(camera|lenses?|media|audio|support|accessories|lighting|power)\s*\([^)]*\)\s*:/gi, " ");
  body = body.replace(/\b(camera|lenses?|media|audio|support|accessories|lighting|power)\s*:/gi, " ");

  // Common misspellings in the real listings — normalise BEFORE matching, so a
  // genuinely-owned component isn't dropped for a typo. Live: "1x 24-105mm f4
  // cannon lens" failed the confidence gate against "Canon EF 24-105mm f4"
  // purely because of "cannon".
  body = body
    .replace(/\bcannon\b/gi, "Canon")
    .replace(/\bannamorphic\b/gi, "anamorphic")
    .replace(/\bsenheiser\b/gi, "Sennheiser")
    .replace(/\blaveliers?\b/gi, "lavalier")
    // Model numbers written with a space or a slash tokenise differently from
    // inventory ("DJI RS 3 Pro" vs item "DJI RS3 Pro gimbal"; "f/4" vs "f4"),
    // which silently dropped two genuinely-owned components.
    .replace(/\b(rs)\s+(\d)\b/gi, "$1$2")
    .replace(/\bf\s*\/\s*(\d)/gi, "f$1")
    // Inventory abbreviates to "BMPCC"; listings write it out in full
    // ("Blackmagic 6K Full Frame Cinema Camera body"), so the CAMERA BODY --
    // the one component that matters most -- failed to match while its battery
    // pack did. Adding the token is safe: the item names still require
    // 6k+pro or 6k+full+frame, so no unrelated Blackmagic gear can match.
    .replace(/\bblackmagic\b/gi, "Blackmagic BMPCC");

  // Split ONLY on an explicit "Nx" quantity marker.
  //
  // Allowing a bare "N " split inside names: "1x 1 TB SSD" broke at "1 TB",
  // and "1.8x T2.9" broke at the decimal, producing garbage components like
  // "1, 8x T2.9" and merged ones like "4x batteries 1x 1TB SSD". A wrong
  // quantity is worse than no mapping — the live parse produced "2x DJI RS3
  // Pro gimbal" from a description that says "1x", by inheriting the "2x"
  // from the DJI Mics before it. The negative lookbehind rejects decimals.
  // PREFER REAL DELIMITERS. diogo's listings — the most detailed we have —
  // write kit lists as proper bullets:
  //   "In this kit: * 1x Blackmagic Pocket Cinema Camera 6K Pro * 5x Batteries
  //    * 1x 2TB SSD * 1x Tilta Shoulder Rig * 1x Canon 24-105mm f4 Lens"
  // Splitting on those bullets never touches a digit, which removes the entire
  // class of bug that made the numeric split unsafe: "1x DJI RS 3 Pro Gimbal"
  // broke at the "3" in "RS 3" and invented a phantom "3x", and "1.8x T2.9"
  // became "1, 8x". Bullets are unambiguous; numbers inside product names are
  // not.
  //
  // Only fall back to the numeric split for listings with no bullets at all.
  const bulletParts = body
    .split(/\s*[*•‣●]\s+|\s+-\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const parts =
    bulletParts.length >= 3
      ? bulletParts
      : body.split(/(?=(?<![\d.])\b\d{1,2}\s*x?\s+(?!(?:tb|gb|mb|mm|k)\b)[A-Za-z])/i);
  const usedBullets = bulletParts.length >= 3;
  const out: Array<{ qty: number; name: string }> = [];
  for (const raw of parts) {
    const p = raw.trim().replace(/^(?:my|a|an|the)\s+/i, "");
    if (!p) continue;
    // Quantity is OPTIONAL on a bullet: diogo writes both "1x Blackmagic
    // Pocket Cinema Camera 6K Pro" and "My Blackmagic Pocket Cinema Camera
    // 6K Full Frame". A bullet with no number is exactly one of that thing.
    const q = p.match(/^(\d{1,2})\s*x?\s+(.*)$/);
    const qty = q ? Math.max(1, Math.min(10, parseInt(q[1], 10))) : 1;
    let name = (q ? q[2] : p).trim().replace(/[.,;]+$/, "");
    if (!usedBullets) {
      // Numeric-split fallback only: a name can otherwise run into the next
      // component, so cut at the next quantity marker.
      name = name.split(/\b\d{1,2}\s*x\s+/)[0].trim();
    }
    // A fragment with no letters or digits is a leftover delimiter, not a
    // component: a lone "*" survived the numeric-split fallback.
    if (!/[a-z0-9]/i.test(name)) continue;
    if (!name || NOISE_RE.test(name) || ADDON_RE.test(name)) continue;
    out.push({ qty, name: name.slice(0, 60) });
  }
  return { components: out, usedBullets };
}
