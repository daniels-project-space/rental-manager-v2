type Capacity = {kind:"ssd"|"card"|"unknown";gb:number};
function capacities(text: string): Capacity[] {
  return [...text.matchAll(/\b(\d+(?:\.\d+)?)\s*(TB|GB)\b/gi)].map(m=>{
    const nearby=text.slice(Math.max(0,m.index!-18),m.index!+m[0].length+30).toLowerCase();
    const kind=/\bssd\b|solid.state/.test(nearby) ? "ssd" as const : /card|cfexpress|cfast|uhs/.test(nearby) ? "card" as const : "unknown" as const;
    return {kind,gb:Number(m[1])*(m[2].toLowerCase()==="tb"?1000:1)};
  });
}
/** Conflicting imported advertising cannot establish what storage is supplied.
 * Neither side wins: require owner review rather than choosing a capacity. */
export function listingMediaConflict(recordedContents: string[], titles: string[]) {
  const recorded=recordedContents.flatMap(capacities);
  return recorded.length>0 && titles.flatMap(capacities).some(claim=>!recorded.some(r=>r.gb===claim.gb && (r.kind===claim.kind || r.kind==="unknown" || claim.kind==="unknown")));
}

/** Keep non-media inclusions, but never let a conflicting recorded capacity
 * become positive kit proof merely because it is stored in inventory. */
export function withoutUnverifiedMediaCapacity(contents: string[]) {
  return contents.filter(text=>capacities(text).length===0);
}
