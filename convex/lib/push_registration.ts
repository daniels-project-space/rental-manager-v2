/** A passive browser refresh can renew its own destination, never take over
 * another device. Previous endpoint is an opaque rotation capability retained
 * by that installation; only the Enable gesture intentionally moves delivery. */
export function ownsPushDestination(args: { endpoint: string; previous_endpoint?: string; activate?: boolean }, currentEndpoint: string | null) {
  return args.activate === true || (currentEndpoint !== null &&
    (args.endpoint === currentEndpoint || args.previous_endpoint === currentEndpoint));
}

export function validatePushSubscription(args: { endpoint: string; p256dh: string; auth: string }) {
  const endpoint = new URL(args.endpoint);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) throw new Error("Invalid push endpoint");
  const decode = (value: string) => atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  const publicKey = decode(args.p256dh);
  if (publicKey.length !== 65 || publicKey.charCodeAt(0) !== 4 || decode(args.auth).length !== 16) throw new Error("Invalid push subscription keys");
}

export async function pushCredentialHash(value:string){
 const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));
 return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,"0")).join("");
}
export async function validPushRenewalCredential(value:string,expected?:string){
 if(!/^[a-f0-9]{64}$/.test(value)||!expected||!/^[a-f0-9]{64}$/.test(expected))return false;
 const actual=await pushCredentialHash(value);let difference=0;
 for(let i=0;i<actual.length;i++)difference|=actual.charCodeAt(i)^expected.charCodeAt(i);
 return difference===0;
}
export const pushKeysHash=(keys:{p256dh:string;auth:string})=>pushCredentialHash(atob(keys.p256dh.replace(/-/g,"+").replace(/_/g,"/"))+"|"+atob(keys.auth.replace(/-/g,"+").replace(/_/g,"/")));
