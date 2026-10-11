import {useMemo} from "react";
const router={push:(url:string)=>{history.pushState(null,"",url);window.dispatchEvent(new PopStateEvent("popstate"));},replace:(url:string)=>history.replaceState(null,"",url),refresh:()=>{},prefetch:()=>Promise.resolve(),back:()=>history.back()};
export const useRouter=()=>router;
export const usePathname=()=>location.pathname;
export const useSearchParams=()=>useMemo(()=>new URLSearchParams(location.search),[location.search]);
