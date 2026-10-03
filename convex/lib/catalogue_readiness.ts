import { normalizeMount } from "./item_name_match";
import type { LensRequirements } from "./lens_requirements";

export type CatalogueReadinessEvidence = { subject: string; source_call_id: string };
const refusal = /^\s*(?:(?:sorry|unfortunately)[, ]+)?(?:I|we)\s+(?:currently\s+)?(?:don't|do not)\s+(?:currently\s+)?have\s+(?:a|an|any)\s+verified\s+(.+?)\s+ready to quote(?: immediately| now| currently)?\s*[.!]?$/i;
/** Epistemic catalogue readiness, never a calendar occupancy verdict. */
export function catalogueReadinessSubject(clause: string) {
 return refusal.exec(clause.replace(/’/g,"'"))?.[1] ?? null;
}
export function readinessSubjectKey(subject:string) {
 return subject.toLowerCase().replace(/\bsony\s+e\b/g,"e").replace(/[^a-z0-9]+/g," ").trim();
}
/** Exact class descriptions only. Unsupported constraints remain owner review;
 * a narrow search cannot prove absence of a broader class. */
export function lensReadinessSubject(req:LensRequirements,mount:string|null) {
 const allowed=new Set(["focus_mode","wide_angle","macro","projection","coverage"]);
 if(Object.entries(req).some(([k,v])=>v!==undefined&&(!allowed.has(k)||v===false))||!Object.keys(req).length)return null;
 const parts=[req.focus_mode?.replace(/_/g," "),req.wide_angle?"wide angle":null,req.macro?"macro":null,req.projection,req.coverage?.replace(/_/g," "),normalizeMount(mount),"lens"].filter(Boolean);
 return parts.join(" ");
}
export function unsupportedCatalogueReadinessClaims(text:string,evidence:CatalogueReadinessEvidence[]) {
 return text.split(/(?<=[.!?])\s+|\n+|;\s*|,\s+|\s+(?:but|however|whereas|while)\s+/i)
  .map(catalogueReadinessSubject).filter((s):s is string=>s!==null)
  .filter(subject=>!evidence.some(e=>e.source_call_id&&readinessSubjectKey(e.subject)===readinessSubjectKey(subject)));
}
