/** Return an unavailable identity only when the renter named one unambiguous
 * catalogue item. A miss or competing identity is never a negative verdict. */
export function labUnavailableMention<T extends {name_canonical:string;aliases?:string[];is_marketing_only?:boolean}>(message:string,items:T[]):T|null {
 if(!/\b(?:available|availability|rent|rental|hire|similar|alternative)\b/i.test(message))return null;
 const norm=(s:string)=>` ${s.toLowerCase().replace(/[^a-z0-9]+/g," ").trim()} `;
 const text=norm(message);
 const matches=items.filter(item=>[item.name_canonical,...(item.aliases??[])].some(name=>name.length>=5 && text.includes(norm(name))));
 return matches.length===1 && matches[0].is_marketing_only===true ? matches[0] : null;
}
