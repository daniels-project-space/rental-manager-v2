import {expect,it} from "vitest";
import {listingMediaConflict,withoutUnverifiedMediaCapacity} from "./listing_media_conflict";
it("requires review when an SSD listing title contradicts the recorded supplied SSD",()=>{
 expect(listingMediaConflict(["1x 1TB SSD"],["Pro body set + 2tb ssd"])).toBe(true);
 expect(listingMediaConflict(["1x 1TB SSD"],["Pro body set + 1 TB SSD"])).toBe(false);
 expect(listingMediaConflict(["1x 1TB SSD"],["Pro body", "Pro body set + 2TB SSD"])).toBe(true);
});
it("does not treat media formats, battery counts or resolutions as supplied capacity",()=>{
 expect(listingMediaConflict(["5x NP-F570 battery","1x 1TB CFexpress Type B card"],["Full Frame 6K camera + 24-105mm lens"])).toBe(false);
 expect(listingMediaConflict(["1TB card"],["1TB SSD"])).toBe(true);
 expect(listingMediaConflict([],["Body + 2TB SSD"])).toBe(false); // No conflicting record is known; this still does not verify contents.
});

it("removes conflicting capacities from kit proof without inventing replacements",()=>{
 expect(withoutUnverifiedMediaCapacity(["5x NP-F570 battery","1x 1TB SSD","256GB card","camera cage","hard carrying case"])).toEqual(["5x NP-F570 battery","camera cage","hard carrying case"]);
});
