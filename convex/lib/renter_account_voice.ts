/** Generation and validation share the same account voice contract. */
export function renterAccountVoice(account:string|null|undefined) {
 const firstPerson=account==="leo"||account==="diogo";
 return {firstPerson,instruction:firstPerson
  ? "Speak as the individual owner using I, me and my, including kit and stock descriptions. Use the account's supplied tone."
  : "Use the account's supplied voice and tone."};
}
