"use client";
import styles from "./RentalControls.module.css";

/** A money preview never executes a charge or refund. Review is explicit. */
export function RentalMoneyControl({mode,total,value,onChange,onReview,busy=false,canReview=true,currency="GBP",limit=total,compact=false}: {
  mode:"price"|"refund";total:number;value:string;onChange:(value:string)=>void;onReview:()=>void;
  busy?:boolean;canReview?:boolean;currency?:string;limit?:number;compact?:boolean;
}) {
  const amount=Number(value),valid=value.trim()!==""&&Number.isFinite(amount)&&amount>=0&&(mode==="price"||amount>0&&amount<=limit);
  const money=(n:number)=>new Intl.NumberFormat("en-GB",{style:"currency",currency,maximumFractionDigits:2}).format(n);
  const change=(n:number)=>onChange(String(Math.round(Math.max(0,n)*100)/100));
  return <section className={styles.moneyControl} data-compact={compact} aria-label={mode==="refund"?"Refund calculator":"Price adjustment"}>
    <div className={styles.moneyReceipt}><span>{mode==="refund"?"Refundable payment":"Current rental price"}</span><strong>{money(mode==="refund"?limit:total)}</strong></div>
    <label className={styles.amountField}>
      <span>{mode==="refund"?"Refund amount":"New rental price"}</span>
      <div><span>{currency==="GBP"?"£":currency}</span><input aria-label={mode==="refund"?"Rental refund amount":"New rental price"} type="number" min={mode==="refund"?0.01:0} max={mode==="refund"?limit:undefined} step="0.01" inputMode="decimal" value={value} disabled={busy} onChange={e=>onChange(e.target.value)}/></div>
    </label>
    {mode==="refund"&&<><input aria-label="Refund amount slider" type="range" min={0} max={Math.max(0,limit)} step="0.01" value={Math.min(limit,Number.isFinite(amount)?Math.max(0,amount):0)} disabled={busy} onChange={e=>change(Number(e.target.value))}/><div className={styles.rangeLabels}><span>{money(0)}</span><span>{money(limit)}</span></div></>}
    <div className={styles.moneyPresets}>
      {(mode==="refund"?[25,50,limit/4,limit]:[-25,-10,10,25]).map((n,index)=><button type="button" key={index} disabled={busy} onClick={()=>change(mode==="refund"?Math.min(limit,n):(Number.isFinite(amount)&&value?amount:total)+n)}>{mode==="refund"?(index===2?"25%":index===3?"Full":money(n)):`${n>0?"+":"−"} ${money(Math.abs(n))}`}</button>)}
    </div>
    <div className={styles.moneyResult}>
      <div><span>{mode==="refund"?"Renter receives":"Price change"}</span><strong>{mode==="price"&&amount-total>0?"+ ":""}{money(valid?(mode==="refund"?amount:amount-total):0)}</strong></div>
      <div><span>{mode==="refund"?"Remaining payment":"New rental price"}</span><b>{money(valid?(mode==="refund"?limit-amount:amount):total)}</b></div>
    </div>
    <button type="button" className={styles.send} disabled={busy||!valid||!canReview} onClick={onReview}>{busy?"Processing…":mode==="refund"?"Review rental refund":"Review price"}</button>
  </section>;
}
