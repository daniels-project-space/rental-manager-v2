"use client";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import styles from "./RequestedItemStack.module.css";
export type StackItem = {
  name: string;
  display_name?: string;
  qty: number;
  image_url: string | null;
  image_urls?: string[];
  origin?: "basket" | "chat";
};
const failedImageUntil = new Map<string, number>();
const loadedImage = new Map<string, { url: string; until: number }>();
const IMAGE_CACHE_MS = 5 * 60_000;
function rememberFailure(url: string) {
  if (failedImageUntil.size >= 1000)
    failedImageUntil.delete(failedImageUntil.keys().next().value!);
  failedImageUntil.set(url, Date.now() + IMAGE_CACHE_MS);
}
export function ItemImage({ item }: { item: StackItem }) {
  const sources = [
    ...new Set([item.image_url, ...(item.image_urls ?? [])].filter(Boolean)),
  ] as string[];
  const [failed, setFailed] = useState<string[]>([]);
  const key = JSON.stringify(sources),
    cached = loadedImage.get(key);
  const usable = (url: string) =>
    !failed.includes(url) && (failedImageUntil.get(url) ?? 0) <= Date.now();
  const src =
    cached && cached.until > Date.now() && usable(cached.url)
      ? cached.url
      : sources.find(usable);
  return src ? (
    <img
      data-no-zoom
      src={src}
      alt={item.display_name ?? item.name}
      onLoad={() => {
        if (loadedImage.size >= 1000)
          loadedImage.delete(loadedImage.keys().next().value!);
        loadedImage.set(key, { url: src, until: Date.now() + IMAGE_CACHE_MS });
      }}
      onError={() => {
        rememberFailure(src);
        loadedImage.delete(key);
        setFailed((old) => [...old, src]);
      }}
    />
  ) : (
    <span
      className={styles.missing}
      aria-label={`No image for ${item.display_name ?? item.name}`}
    >
      ◇
    </span>
  );
}
/** The compact stack keeps its footprint while cards expand outward. */
export function RequestedItemStack({
  items, size=38, alwaysExpanded=false, expandedLabel="All requested items",boundarySelector,
}: {items:StackItem[];size?:number;alwaysExpanded?:boolean;expandedLabel?:string;boundarySelector?:string}) {
  const [open,setOpen]=useState(false);
  const [availableWidth,setAvailableWidth]=useState(size+14);
  const [direction,setDirection]=useState(1);
  const [focused,setFocused]=useState<number|null>(null);
  const ref=useRef<HTMLDivElement>(null);
  useEffect(()=>{
    const parent=boundarySelector?ref.current?.closest(boundarySelector):ref.current?.parentElement;if(!parent)return;
    const measure=()=>{
      if(!ref.current)return;
      const bounds=parent.getBoundingClientRect(),slot=ref.current.getBoundingClientRect();
      const left=Math.max(0,slot.left-bounds.left-4),right=Math.max(0,bounds.right-slot.left-size-4);
      setDirection(left>right?-1:1);
      setAvailableWidth(size+Math.max(left,right));
    };
    const observer=new ResizeObserver(measure);observer.observe(parent);measure();
    return ()=>observer.disconnect();
  },[size,boundarySelector]);
  useEffect(()=>{
    if(!open)return;
    const outside=(event:PointerEvent)=>{if(!ref.current?.contains(event.target as Node)){setOpen(false);setFocused(null);}};
    document.addEventListener("pointerdown",outside);
    return ()=>document.removeEventListener("pointerdown",outside);
  },[open]);
  if(!items.length)return <span className={styles.empty}>◇</span>;
  if(alwaysExpanded)return <div data-requested-stack data-expanded="true" data-inline-expanded="true" className={styles.inline}>
    <section className={styles.expansion} aria-label={expandedLabel}>{items.map((item,index)=><article key={`${index}-${item.name}`}>
      <ItemImage item={item}/><strong>{item.display_name??item.name}</strong><small>{item.qty}× · {item.origin==="chat"?"Mentioned in chat":"In basket"}</small>
    </article>)}</section>
  </div>;
  const spacing=items.length>1?Math.max(0,Math.min(size+10,(availableWidth-size-6)/(items.length-1))):0;
  const baseWidth=size+Math.min(items.length-1,2)*7;
  return <div ref={ref} data-requested-stack data-expanded={open} data-inline-expanded="false" className={styles.container}
    style={{width:baseWidth,height:size+8,"--stack-size":`${size}px`} as CSSProperties}
    onPointerEnter={event=>{if(event.pointerType==="mouse")setOpen(true);}}
    onPointerLeave={event=>{if(event.pointerType==="mouse"){setOpen(false);setFocused(null);}}}
    onKeyDown={event=>{
      if(event.key==="Escape"){event.stopPropagation();setOpen(false);setFocused(null);}
      if(open&&(event.key==="ArrowRight"||event.key==="ArrowLeft")){event.preventDefault();setFocused(value=>((value??0)+(event.key==="ArrowRight"?1:items.length-1))%items.length);}
    }}>
    <button type="button" className={styles.stack} style={{width:baseWidth,height:size+8}}
      aria-label={`Show all ${items.length} requested items`} aria-expanded={open}
      onFocus={event=>{if(event.currentTarget.matches(":focus-visible"))setOpen(true);}}
      onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node)){setOpen(false);setFocused(null);}}}
      onClick={event=>{event.stopPropagation();const pointer=(event.nativeEvent as PointerEvent).pointerType;setOpen(value=>pointer==="mouse"?true:!value);}}>
      {items.map((item,index)=>{
        const visible=open||index<3;
        const rotation=open&&focused!==index?(index-(items.length-1)/2)*Math.min(3,12/Math.max(items.length,1)):0;
        return <span key={`${index}-${item.name}`} data-stack-layer className={styles.layer}
          title={`${item.display_name??item.name} · ${item.qty}× · ${item.origin==="chat"?"Mentioned in chat":"In basket"}`}
          onPointerEnter={()=>setFocused(index)} onPointerLeave={()=>setFocused(null)}
          style={{width:size,height:size,opacity:visible?1:0,pointerEvents:visible?"auto":"none",zIndex:focused===index?items.length+1:items.length-index,
            transform:`translate(${open?direction*index*spacing:Math.min(index,2)*7}px, ${open?0:Math.min(index,2)*4}px) rotate(${rotation}deg)`}}>
          <ItemImage item={item}/>{open&&item.qty>1&&<small className={styles.quantity}>{item.qty}×</small>}
        </span>;
      })}
      {!open&&items.length>1&&<b className={styles.count}>{items.length}</b>}
    </button>
  </div>;
}
