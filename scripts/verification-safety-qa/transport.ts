export function useConvexAuth(){return {isLoading:false,isAuthenticated:true};}
export function useQuery(_reference:unknown,args:any){
  if(!args?.reservationId)return {isOwner:true};
  return {bookingStatus:'confirmed',syncedAt:Date.now()-3600000,websiteUrl:'https://example.invalid/admin',verification:{status:'verified',approved:true,documentsApproved:true,securityReady:true,archiveReady:true,requiresDroneLicence:false,accountId:'fixture',checks:{identity:'approved',selfie:'approved',address:'approved'}}};
}
export function useAction(){return async()=>({ok:true});}
