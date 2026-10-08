/** Retain authoritative contents intact; prompt limits belong at prompt use. */
export function retainedListingDescription(description:string):string {
  if(description.length>20_000)throw Error("Listing description exceeds supported length");
  return description;
}
