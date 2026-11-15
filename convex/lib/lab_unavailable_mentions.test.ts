import {it,expect} from "vitest";
import {labUnavailableMention} from "./lab_unavailable_mentions";
it("only identifies an explicit, unique owner-confirmed unavailable item",()=>{
 const pyxis={name_canonical:"Blackmagic Pyxis",aliases:["Pyxis"],is_marketing_only:true};
 const owned={name_canonical:"Sony A7 III",aliases:["A7 III"],is_marketing_only:false};
 expect(labUnavailableMention("Is Blackmagic Pyxis available?",[pyxis,owned])).toEqual(pyxis);
 expect(labUnavailableMention("Is Sony A7 III available?",[pyxis,owned])).toBeNull();
 expect(labUnavailableMention("Is Pyxis available?",[pyxis,{...owned,aliases:["Pyxis"]}])).toBeNull();
 expect(labUnavailableMention("Is an unknown camera available?",[pyxis,owned])).toBeNull();
 expect(labUnavailableMention("Tell me about Pyxis",[pyxis,owned])).toBeNull();
});
