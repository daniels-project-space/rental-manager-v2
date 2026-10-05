/** Native financial evidence proves complete rendered lines, never a prefix
 * of an edited amount. Shared by informational values and rental offers. */
export function nativeFinancialBlockPositions(text:string,block:string):number[]{
 const found:number[]=[];
 if(!block)return found;
 let at=text.indexOf(block);
 while(at>=0){
  if((at===0||text[at-1]==="\n")&&(at+block.length===text.length||text[at+block.length]==="\n"))found.push(at);
  at=text.indexOf(block,at+1);
 }
 return found;
}

export function selectNativeFinancialBlocks<T>(facts:T[]|undefined,savedText:string|undefined,text:string,format:(fact:T)=>string|null){
 let claim_text=text;const selected:T[]=[];const seen=new Set<string>();
 for(const fact of facts??[]){
  const block=format(fact);
  if(!block||seen.has(block)||!savedText||nativeFinancialBlockPositions(savedText,block).length!==1||nativeFinancialBlockPositions(text,block).length>1)return {ok:false,claim_text:text,selected:[] as T[]};
  seen.add(block);
  const positions=nativeFinancialBlockPositions(claim_text,block);
  if(positions.length===1){
   selected.push(fact);
   const at=positions[0];claim_text=claim_text.slice(0,at)+claim_text.slice(at+block.length);
  }
 }
 return {ok:true,claim_text,selected};
}
