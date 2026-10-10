"use client";
import {useEffect,useMemo,useState} from "react";
import {stockNowCard,type StockNowInput} from "../stock-now";

/** Update at actual stock boundaries without polling Convex or fetching the
 * dashboard again. Recheck when a background tab becomes visible. */
export function useStockBoundaryClock(inputs:StockNowInput[]|undefined){
 const [at,setAt]=useState(()=>Date.now());
 useEffect(()=>{
  if(!inputs)return;
  let timer:ReturnType<typeof setTimeout>|undefined;
  const refresh=()=>{
   if(timer!==undefined)clearTimeout(timer);
   const now=Date.now();setAt(now);
   const next=Math.min(...inputs.flatMap(i=>i.windows.flatMap(w=>[w.start,w.end])).filter(t=>t>now));
   timer=Number.isFinite(next)?setTimeout(refresh,Math.min(2_147_483_647,Math.max(1,next-now))):undefined;
  };
  refresh();
  const visible=()=>{if(document.visibilityState==="visible")refresh();};
  document.addEventListener("visibilitychange",visible);
  return()=>{if(timer!==undefined)clearTimeout(timer);document.removeEventListener("visibilitychange",visible);};
 },[inputs]);
 return at;
}
export function useStockNow(inputs:StockNowInput[]|undefined){
 const at=useStockBoundaryClock(inputs);
 return useMemo(()=>inputs?stockNowCard(inputs,at):undefined,[inputs,at]);
}
