/** Shared IndexedDB with the worker. Creation is one serialized transaction,
 * so simultaneous tabs cannot mint different credentials for one installation. */
export function pushDeviceCredential(rotate=false):Promise<string>{
 return new Promise((resolve,reject)=>{
  const open=indexedDB.open("rental-manager-push",1);
  open.onupgradeneeded=()=>open.result.createObjectStore("registration");
  open.onerror=()=>reject(open.error);open.onblocked=()=>reject(new Error("Push storage blocked"));
  open.onsuccess=()=>{
   const db=open.result,transaction=db.transaction("registration","readwrite"),store=transaction.objectStore("registration");
   let credential:string;
   const get=store.get("renewal_credential");
   get.onsuccess=()=>{
    if(!rotate&&typeof get.result==="string"&&/^[a-f0-9]{64}$/.test(get.result))credential=get.result;
    else{credential=Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,"0")).join("");store.put(credential,"renewal_credential");}
   };
   transaction.oncomplete=()=>{db.close();resolve(credential);};
   transaction.onerror=()=>{db.close();reject(transaction.error);};transaction.onabort=()=>{db.close();reject(transaction.error);};
  };
 });
}
