import type {LensCapabilities} from "./lens_requirements";
import {bestMatch,normalizeApertureNotation} from "./item_name_match";
import {declaredLensReferences,lensClaimReferences} from "./lens_claim_references";
import {itemReferenceLabel} from "./renter_claim_structure";
export type LensFocusEvidence={names:string[];capabilities:LensCapabilities|null};
const normal=(s:string)=>normalizeApertureNotation(s).toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
/** Reviewed capability claims, not stock, mount names or model self-reports.
 * Unnamed singular references require one actual requested/previous lens. */
export function unsupportedLensFocusClaims(text:string,evidence:LensFocusEvidence[],initialNames:string[]=[],cameraNames:string[]=[]) {
 const refs=lensClaimReferences(evidence.map(item=>({names:item.names,item})),(a,b)=>normal(a[0])===normal(b[0]));
 const initial=evidence.filter(e=>e.names.some(n=>initialNames.some(i=>normal(i)===normal(n))));
 let subject=initial.length===1?initial:[];
 const failures:string[]=[];
 for(const clause of text.replace(/’/g,"'").split(/(?<=[.!?])\s+|\n+|[,;]|\b(?:but|while|whereas)\b/i)) {
  for(const focus of clause.matchAll(/\b(auto[- ]?focus|manual[- ]focus(?:\s+only)?|AF)\b/gi)) {
  if(/^\s*(?:does|do|can|could|would|is|are)\b/i.test(clause) && /\?\s*$/.test(clause))continue;
  const prefix=clause.slice(0,focus.index);
  if(/\b(?:if|whether|check(?:ing)?|verify(?:ing)?|confirm(?:ing)?|want|need|require|prefer|looking for)\b[^;:]{0,100}$/i.test(prefix))continue;
  const predicates=[...prefix.matchAll(/\b(?:it's|that's|they're|has|have|supports?|offers?|uses?|features?|is|are|can(?:not|'t)?|does(?:n't| not)?|do(?:n't| not)?)\b/gi)];
  const predicate=predicates[0];
  const noun=(predicate?prefix.slice(0,predicate.index):prefix).trim().replace(/^(?:(?:the|a|an|my|our|your|this|that)\s+)+/i,"");
  const reference=itemReferenceLabel(noun.split(/\s+from\s+/i)[0],"lens");
  const generic=/^(?:it|this|that|the same lens|lens|this lens|that lens)?$/i.test(reference);
  if(!generic && bestMatch(reference,cameraNames,n=>n).confident){subject=[];continue;}
  if(!generic) {
   const declared=declaredLensReferences(normal(reference));
   const candidates=evidence.filter(e=>declared.every(key=>normal(refs.get(key)?.item.names[0]??"")===normal(e.names[0])));
   const match=bestMatch(reference,candidates,e=>e.names[0],e=>e.names.slice(1));
   subject=match.confident&&match.match?[match.match]:[];
   // Identical physical copies share model identity, but every current review
   // must prove the feature. Different variants remain ambiguous.
   if(!subject.length && match.match && match.ambiguousWith.length && match.ambiguousWith.every(e=>normal(e.names[0])===normal(match.match!.names[0])))subject=[match.match,...match.ambiguousWith];
  }
  const polarity=prefix.split(/\s+and\s+/i).at(-1)!;
  const negative=/\b(?:not|no|without|isn't|aren't|doesn't|does not|don't|do not|cannot|can't|lacks?)\b/i.test(polarity);
  const autofocus=/^(?:auto[- ]?focus|AF)$/i.test(focus[1]),only=/\bonly\b/i.test(focus[1])||/^\s*(?:only|lens only)\b/i.test(clause.slice(focus.index+focus[0].length));
  const verified=subject.length>0 && subject.every(e=>{
   const cap=e.capabilities;if(!cap)return false;
   if(autofocus)return negative?cap.focus_mode==="manual_focus":cap.focus_mode==="autofocus";
   if(only)return cap.focus_mode===(negative?"autofocus":"manual_focus");
   const manual=cap.focus_mode==="manual_focus"?true:cap.manual_focus_available;
   return manual!==undefined && manual===!negative;
  });
  if(!verified)failures.push(clause.trim());
  }
 }
 return [...new Set(failures)];
}
