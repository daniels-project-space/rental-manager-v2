import { equipmentClaimClauses } from "./renter_statement_scope";
import { matchesRecordingRequirement, type CameraCapabilities, type RecordingRequirement, type RecordingResolution } from "./camera_requirements";

export type CameraEvidence = { names: string[]; capabilities: CameraCapabilities };
function mentionsCamera(text: string, name: string) {
  const parts = name.toLowerCase().match(/[a-z0-9]+/g);
  return !!parts?.length && new RegExp(`(?:^|[^a-z0-9])${parts.join("[^a-z0-9]*")}(?=$|[^a-z0-9])`, "i").test(text);
}
const explicitCameraModel = /\b(?:Sony\s+(?:A7\s*(?:III|II|IV|V|S\s*III)?|FX\d+)|Canon\s+(?:EOS\s+)?(?:C\d+|R\d+)|Nikon\s+Z\d+|(?:Blackmagic|BMPCC|Pyxis|Komodo|RED|ARRI)\b)/i;
// Named-item scope crosses sentences, but never switches because of a model's
// own claimed provenance. Evidence is supplied by the reviewed catalog query.
// Keep identity labels out of capability parsing while preserving offsets for
// claim scope. Use current inventory/model names, longest first, so an alias
// cannot leave a capability-sounding suffix behind.
function cameraClaimContent(text:string,evidence:CameraEvidence[]) {
  const names=[...new Set(evidence.flatMap(e=>e.names))].sort((a,b)=>b.length-a.length);
  return names.reduce((content,name)=>{
    const parts=name.toLowerCase().match(/[a-z0-9]+/g);
    return parts?.length?content.replace(new RegExp(`(?<![a-z0-9])${parts.join("[^a-z0-9]*")}(?![a-z0-9])`,"gi"),match=>" ".repeat(match.length)):content;
  },text);
}

export function unsupportedCameraModeClaims(text: string, evidence: CameraEvidence[]) {
  const failures: string[] = [];
  let subject: CameraEvidence[] = [];
  for (const sentence of text.split(/(?<=[.!?])\s+|\n/)) {
    const named = evidence.filter(e => e.names.some(n => n && mentionsCamera(sentence, n)));
    if (named.length) subject = named;
    else if (explicitCameraModel.test(sentence)) subject = [];
    const content=cameraClaimContent(sentence,evidence);
    const mode = /\b4k\s*(?:at\s*|up to\s*)?(\d{2,3})(?:\.\d+)?\s*(?:p|fps|frames?\s*(?:per|\/)\s*second)\b|\b4k\b[^.!?]{0,35}?\b(\d{2,3})(?:\.\d+)?\s*(?:fps|p)\b|\b(\d{2,3})(?:\.\d+)?\s*fps\b[^.!?]{0,25}?\b4k\b/gi;
    const claims=[...content.matchAll(mode)].map(match=>({match,fps:Number(match[1]??match[2]??match[3])}));
    // Format proof is still required when no frame rate is stated. Rate claims
    // above are checked separately, so a format-only match cannot weaken them.
    for(const match of content.matchAll(/\b(?:UHD|DCI)\s+4k\b|\b4k\s+(?:UHD|DCI)\b/gi))claims.push({match,fps:NaN});
    for (const {match,fps} of claims) {
      // A negative/conditional recording claim is not a promise that a mode
      // can be supplied. Do not let a different clause excuse an assertion.
      // Use positions: repeated "4K120p" in the conditional and promise must
      // not select the first clause for both occurrences.
      let start = 0, end = sentence.length;
      // Parenthetical subject lists are aside phrases, not a new governing
      // predicate. Preserve their positions while masking boundaries when the
      // recording claim lies outside them. A claim INSIDE an aside keeps its
      // own scope, so "checking ... (FX3 records DCI 4K)" is still checked.
      const boundaries = sentence.replace(/\([^()]*\)/g, (aside, offset: number) =>
        match.index! >= offset && match.index! < offset + aside.length ? aside : " ".repeat(aside.length));
      for (const separator of boundaries.matchAll(/[,;()]|\bbut\b/gi)) {
        if (separator.index! < match.index!) start = separator.index! + separator[0].length;
        else { end = separator.index!; break; }
      }
      const clause = sentence.slice(start, end),claimClause=content.slice(start,end);
      const clauseNamed = evidence.filter(e => e.names.some(n => n && mentionsCamera(clause, n)));
      if (clauseNamed.length) subject = clauseNamed;
      else if (explicitCameraModel.test(clause)) subject = [];
      // A comma between adjectives ("uncropped, full-width 4K120") does not
      // start a new assertion. A named camera/new predicate after a comma
      // does, so a preceding conditional/negative cannot license that promise.
      const independentAssertion = clauseNamed.length > 0 || explicitCameraModel.test(clause) ||
        /\b(?:records|shoots|supports|achieves|can|does|is|has|offers|tops\s*out|requires)\b|\b(?:they|these|those|bodies|cameras|models)\s+(?:record|shoot|support|achieve|offer|require)\b/i.test(clause.slice(0, match.index! - start));
      const polarityScope = start > 0 && sentence[start - 1] === "," && !independentAssertion ? sentence.slice(0, end) : clause;
      // A fronted request phrase has its governing predicate AFTER the comma:
      // "For a camera recording ..., I'm checking the recording specs." It
      // describes the search target, not a verified capability. Only carry that
      // predicate back to the request phrase; never to a named-body assertion
      // or a later independent promise in the same sentence.
      const reviewTarget = start === 0 && !clauseNamed.length && !explicitCameraModel.test(clause) &&
        /^\s*(?:for|regarding|about)\b/i.test(clause) &&
        !/\b(?:records?|shoots?|supports?|achieves?|can|does|is|has|offers?)\b/i.test(clause) &&
        /^\s*,\s*I(?:['’]m| am|['’]ll| will)\s+(?:checking|check|verifying|verify|confirming|confirm)\b/i.test(sentence.slice(end));
      if (reviewTarget) continue;
      if (/\b(?:does(?:n['’]t| not)|do(?:n['’]t| not)\s+(?:stock|have|offer)|can(?:not|['’]t)|won['’]t|not support|not (?:full.frame|uncropped)|if|whether|check(?:ing|ed)?)\b|^\s*(?:none of|neither\b)/i.test(polarityScope) || /\byou\s+(?:want|need|require|prefer)\b/i.test(polarityScope)) continue;
      const nominalFps = fps === 119 ? 120 : fps === 59 ? 60 : fps === 29 ? 30 : fps === 23 ? 24 : fps;
      const hasApsc = /\b(?:aps.c|super\s*35)\b/i.test(claimClause) &&
        !/\b(?:without|not|no|rather than|instead of)\b[^,;]{0,30}\b(?:aps.c|super\s*35)\b|\b(?:aps.c|super\s*35)(?:\s*\/\s*S35)?\s+(?:shooting|mode)\s+(?:is\s+)?off\b/i.test(claimClause);
      const fullWidth = /\b(?:uncropped|full.width|full.sensor.width|entire sensor|full.frame image area)\b|\b(?:no|without|zero)\s+(?:any\s+)?crop\b/i.test(claimClause);
      // A generic 4K claim can use either concrete reviewed 4K format.
      // An explicit UHD/DCI claim needs that exact format's own mode proof.
      const formats:RecordingResolution[]=[...claimClause.matchAll(/\b(UHD|DCI)\b/gi)].flatMap(label=>{
        const before=claimClause.slice(0,label.index);
        return /\b(?:not|without|rather than|instead of)\s*$/i.test(before) ? [] : [label[1].toUpperCase()==="UHD" ? "uhd_4k" : "dci_4k"];
      });
      const requirement: RecordingRequirement = { resolution: "4k", ...(Number.isFinite(nominalFps)?{min_fps:nominalFps}:{}),
        ...(hasApsc ? { capture_format: "aps_c" } : /\bfull.frame\b/i.test(claimClause) ? { capture_format: "full_frame" } : {}),
        ...(fullWidth ? { full_width: true } : {}) };
      const locations=[...new Set([...claimClause.matchAll(/\b(internal(?:ly)?|external(?:ly)?)\b/gi)].flatMap(label=>{
        const before=claimClause.slice(0,label.index),after=claimClause.slice(label.index!+label[0].length);
        // Recording location describes encoding, not an external SSD, power
        // supply or microphone. Adjectives must govern a recording phrase.
        const recordingLocation=/ly$/i.test(label[1])||/^\s+(?:(?:and|or)\s+(?:internal|external)\s+)?(?:(?:uncropped|cropped|full.frame|full.width|UHD|DCI)\s+)*(?:4k(?=\d|\b)|record(?:er|ing)\b|video\b|capture\b)/i.test(after);
        return !recordingLocation||/\b(?:not|without|rather than|instead of)\s*$/i.test(before)?[]:[/^internal/i.test(label[1])];
      }))];
      const candidates = clauseNamed.length ? clauseNamed : subject;
      if (!candidates.length || !candidates.every(e => (locations.length?locations:[undefined]).every(internal=>e.capabilities.recording_modes?.some(m =>
        (Number.isNaN(nominalFps)||m.nominal_fps.includes(nominalFps)) && matchesRecordingRequirement(m, {...requirement,internal}))
        && formats.every(resolution=>e.capabilities.recording_modes?.some(m=>(Number.isNaN(nominalFps)||m.nominal_fps.includes(nominalFps))&&matchesRecordingRequirement(m,{...requirement,resolution,internal})))))) failures.push(sentence.trim());
    }
  }
  return [...new Set(failures)];
}


/** Intrinsic ND belongs to the reviewed body profile, not accessory contents. */
export function unsupportedBuiltInNDClaims(text: string, evidence: CameraEvidence[], initialNames: string[] = []) {
  const failures: string[] = [];
  const initial = evidence.filter(e => e.names.some(n => initialNames.includes(n)));
  let subject = initial.length === 1 ? initial : [];
  for (const clause of equipmentClaimClauses(text, part => explicitCameraModel.test(part) || evidence.some(e => e.names.some(n => mentionsCamera(part, n))))) {
    const named = evidence.map(e => ({ e, length: Math.max(0, ...e.names.filter(n => mentionsCamera(clause, n)).map(n => n.length)) })).filter(m => m.length);
    if (named.length) {
      const longest = Math.max(...named.map(m => m.length));
      subject = named.filter(m => m.length === longest).map(m => m.e);
    } else if (explicitCameraModel.test(clause)) subject = [];
    const claim = /\b(?:built[ -]?in|internal)\s+(?:variable\s+)?NDs?\b/i.exec(clause);
    if (!claim) continue;
    const prefix = clause.slice(0, claim.index);
    // A generic inventory decline describes the requested class of gear,
    // not the intrinsic features of the prior camera subject. Stock guards
    // still require a real negative availability result for that decline.
    const inventoryDecline = /\b(?:don't|do not|cannot|can't)\s+(?:have|supply|provide|offer|find)\b[^.!?]{0,110}$/i.test(prefix) ||
      /\b(?:no|none|not any)\b[^.!?]{0,70}\b(?:camera|body|bodies|kit)s?\b[^.!?]{0,45}$/i.test(prefix);
    if (!named.length && !explicitCameraModel.test(clause) && inventoryDecline) continue;
    if (/\b(?:if|whether|check|verify|confirm)\b[^,;:]{0,100}$/i.test(prefix) || /\b(?:want|need|require|prefer|looking for)\b[^,;:]{0,45}$/i.test(prefix)) continue;
    const negative = /\b(?:no|not|without|isn't|aren't|doesn't|does not|lack|lacks)\b[^,;:()]{0,45}$/i.test(prefix);
    if (!subject.length || !subject.every(e => e.capabilities.built_in_nd === !negative)) failures.push(clause.trim());
  }
  return failures;
}
