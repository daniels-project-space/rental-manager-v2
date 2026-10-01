import { matchesRecordingRequirement, type CameraCapabilities, type RecordingRequirement } from "./camera_requirements";

export type CameraEvidence = { names: string[]; capabilities: CameraCapabilities };
function mentionsCamera(text: string, name: string) {
  const parts = name.toLowerCase().match(/[a-z0-9]+/g);
  return !!parts?.length && new RegExp(`(?:^|[^a-z0-9])${parts.join("[^a-z0-9]*")}(?=$|[^a-z0-9])`, "i").test(text);
}
const explicitCameraModel = /\b(?:Sony\s+(?:A7\s*(?:III|II|IV|V|S\s*III)?|FX\d+)|Canon\s+(?:EOS\s+)?(?:C\d+|R\d+)|Nikon\s+Z\d+|(?:Blackmagic|BMPCC|Pyxis|Komodo|RED|ARRI)\b)/i;
// Named-item scope crosses sentences, but never switches because of a model's
// own claimed provenance. Evidence is supplied by the reviewed catalog query.
export function unsupportedCameraModeClaims(text: string, evidence: CameraEvidence[]) {
  const failures: string[] = [];
  let subject: CameraEvidence[] = [];
  for (const sentence of text.split(/(?<=[.!?])\s+|\n/)) {
    const named = evidence.filter(e => e.names.some(n => n && mentionsCamera(sentence, n)));
    if (named.length) subject = named;
    else if (explicitCameraModel.test(sentence)) subject = [];
    const mode = /\b4k\s*(?:at\s*|up to\s*)?(\d{2,3})(?:\.\d+)?\s*(?:p|fps|frames?\s*(?:per|\/)\s*second)\b|\b4k\b[^.!?]{0,35}?\b(\d{2,3})(?:\.\d+)?\s*(?:fps|p)\b|\b(\d{2,3})(?:\.\d+)?\s*fps\b[^.!?]{0,25}?\b4k\b/gi;
    for (const match of sentence.matchAll(mode)) {
      // A negative/conditional recording claim is not a promise that a mode
      // can be supplied. Do not let a different clause excuse an assertion.
      // Use positions: repeated "4K120p" in the conditional and promise must
      // not select the first clause for both occurrences.
      let start = 0, end = sentence.length;
      for (const separator of sentence.matchAll(/[,;]|\bbut\b/gi)) {
        if (separator.index! < match.index!) start = separator.index! + separator[0].length;
        else { end = separator.index!; break; }
      }
      const clause = sentence.slice(start, end);
      const clauseNamed = evidence.filter(e => e.names.some(n => n && mentionsCamera(clause, n)));
      if (clauseNamed.length) subject = clauseNamed;
      else if (explicitCameraModel.test(clause)) subject = [];
      if (/\b(?:does(?:n['’]t| not)|can(?:not|['’]t)|not support|not (?:full.frame|uncropped)|if|whether|check)\b/i.test(clause)) continue;
      const fps = Number(match[1] ?? match[2] ?? match[3]);
      const nominalFps = fps === 119 ? 120 : fps === 59 ? 60 : fps === 29 ? 30 : fps === 23 ? 24 : fps;
      const hasApsc = /\b(?:aps.c|super\s*35)\b/i.test(clause) && !/\b(?:without|not|no)\b[^,;]{0,30}\b(?:aps.c|super\s*35)\b/i.test(clause);
      const fullWidth = /\b(?:uncropped|full.width|full.sensor.width|entire sensor|full.frame image area)\b|\b(?:no|without|zero)\s+(?:any\s+)?crop\b/i.test(clause);
      const requirement: RecordingRequirement = { resolution: "uhd_4k", min_fps: nominalFps,
        ...(hasApsc ? { capture_format: "aps_c" } : /\bfull.frame\b/i.test(clause) ? { capture_format: "full_frame" } : {}),
        ...(fullWidth ? { full_width: true } : {}) };
      const candidates = clauseNamed.length ? clauseNamed : subject;
      if (!candidates.length || !candidates.every(e => e.capabilities.recording_modes?.some(m =>
        m.nominal_fps.includes(nominalFps) && matchesRecordingRequirement(m, requirement)))) failures.push(sentence.trim());
    }
  }
  return [...new Set(failures)];
}
