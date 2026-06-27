/**
 * RenterDNA — a compact 5-axis read of who we're talking to, derived purely
 * from the renter's own messages. Port of the V1 bot's classify.ts profileRenter
 * (/home/ubuntu/rental-manager/src/pipeline/classify.ts), mapped to the V2
 * renters.renter_dna vocabulary.
 *
 * Self-contained (no external data): we already have the transcript. The draft
 * uses it for tone adaptation only — it is NEVER quoted to the renter.
 */

export interface RenterDna {
  style?: string; // formal | casual | terse | chatty
  expertise?: string; // pro | intermediate | beginner
  driver?: string; // price | quality | speed | trust
  energy?: string; // calm | excited | anxious | impatient
  decisionSpeed?: string; // quick | deliberate | slow | flipflop
  signals_observed?: number;
  updated_at?: number;
}

const has = (t: string, re: RegExp) => re.test(t);

/**
 * Build a DNA read from the renter's messages. `prior` is the previously-stored
 * DNA — when the new signal is weak (very little renter text) we keep the prior
 * value on each axis rather than overwriting it with a guess (V1's
 * short-message-preservation rule).
 */
export function profileRenter(
  renterMessages: string[],
  prior?: RenterDna,
  now?: number,
): RenterDna {
  const msgs = renterMessages.map((m) => (m ?? "").trim()).filter(Boolean);
  const all = msgs.join("  ").toLowerCase();
  const wordCount = all ? all.split(/\s+/).length : 0;
  const avgWords = msgs.length ? wordCount / msgs.length : 0;
  const longest = msgs.reduce((mx, m) => Math.max(mx, m.split(/\s+/).length), 0);

  // Too little to read — keep whatever we had, just bump the counter.
  if (wordCount < 4) {
    return {
      ...prior,
      signals_observed: (prior?.signals_observed ?? 0) + msgs.length,
      updated_at: now,
    };
  }

  const keep = <K extends keyof RenterDna>(k: K, v: RenterDna[K]): RenterDna[K] =>
    (v ?? prior?.[k]) as RenterDna[K];

  // style
  let style: string | undefined;
  if (avgWords <= 4) style = "terse";
  else if (longest > 30) style = "chatty";
  else if (has(all, /\b(hey|yeah|yep|nope|cool|cheers|ta|mate|wicked|sick|lol|haha|gonna|wanna)\b/))
    style = "casual";
  else if (wordCount > 25 && has(all, /\b(regards|kindly|please advise|i would like|could you please|to whom)\b/))
    style = "formal";
  style = keep("style", style);

  // expertise
  let expertise: string | undefined;
  if (
    has(
      all,
      /\b(f2\.8|e-?mount|rf mount|s-?log|c-?log|raw|braw|prores|codec|v-?mount|xlr|sdi|timecode|lut|dynamic range|anamorphic|rec709|davinci|nd filter|focal length|stop down|bit depth|10-?bit|4:2:2)\b/,
    )
  )
    expertise = "pro";
  else if (
    has(
      all,
      /\b(good camera|nice one|what do you recommend|beginner|first time|never used|simple|easy to use|just need|not sure what|new to this|help me choose)\b/,
    )
  )
    expertise = "beginner";
  else expertise = "intermediate";
  expertise = keep("expertise", expertise);

  // driver
  let driver: string | undefined;
  const price = has(all, /\b(price|cost|how much|expensive|cheap|cheaper|budget|afford|worth|value|deal|discount)\b/);
  const quality = has(all, /\b(best|quality|professional|specs|resolution|4k|6k|8k|cinema|premium|top-?end|sharp|pristine)\b/);
  const speed = has(all, /\b(deliver|delivery|pickup|quick|quickly|asap|today|tomorrow|ready|when can|available now|fast|urgent)\b/);
  const trust = has(all, /\b(review|reviews|reliable|trust|trusted|insurance|insured|deposit|safe|legit|genuine|condition)\b/);
  if (price) driver = "price";
  else if (trust) driver = "trust";
  else if (quality) driver = "quality";
  else if (speed) driver = "speed";
  driver = keep("driver", driver);

  // energy
  let energy: string | undefined;
  if (has(all, /(!{1,}|can'?t wait|so excited|amazing|love it|perfect|brilliant|awesome|stoked)/))
    energy = "excited";
  else if (has(all, /\b(asap|right now|urgently|need it (?:now|today)|how long|still waiting|hurry|quickly please)\b/))
    energy = "impatient";
  else if (has(all, /\b(not sure|maybe|hmm|worried|nervous|a bit concerned|hope (?:it|that)|is it safe|what if)\b/))
    energy = "anxious";
  else energy = "calm";
  energy = keep("energy", energy);

  // decisionSpeed
  let decisionSpeed: string | undefined;
  if (has(all, /\b(book it|go ahead|let'?s do it|i'?ll take it|send the request|sounds good|confirmed?|done deal|sign me up)\b/))
    decisionSpeed = "quick";
  else if (has(all, /\b(actually|on second thought|changed my mind|or maybe|instead|wait,|hmm let me|never mind)\b/))
    decisionSpeed = "flipflop";
  else if (has(all, /\b(think about it|let me check|get back to you|not yet|later|might|considering|comparing|deciding)\b/))
    decisionSpeed = "slow";
  else if (msgs.length >= 3 && (all.match(/\?/g)?.length ?? 0) >= 3) decisionSpeed = "deliberate";
  decisionSpeed = keep("decisionSpeed", decisionSpeed);

  return {
    style,
    expertise,
    driver,
    energy,
    decisionSpeed,
    signals_observed: (prior?.signals_observed ?? 0) + msgs.length,
    updated_at: now,
  };
}

/** One-line, human-readable summary for the draft prompt (tone hint only). */
export function dnaSummary(d?: RenterDna | null): string | null {
  if (!d) return null;
  const parts = [d.style, d.expertise, d.driver && `${d.driver}-driven`, d.energy, d.decisionSpeed]
    .filter(Boolean)
    .join(", ");
  return parts || null;
}
