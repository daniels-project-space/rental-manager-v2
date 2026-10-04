const normal = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
const clean = (value: string) => value.trim().replace(/^(?:an?|the)\s+/i, "").replace(/\s+(?:camera(?:\s+body)?|body)$/i, "").trim();
const generic = /^(?:(?:own|current|rental|booked|chosen|specific|other|second|different|same|new|main)\s*)*$/i;
const sentences = (text: string) => text.replace(/’/g, "'").split(/(?<=[.!?])\s+|\n+/);

/** The latest explicit self-description supplies identity. Lens mounts,
 * owner replies, hypothetical questions and rental contents do not. */
export function renterCameraIdentities(messages: string[]): string[] {
  let identities: string[] = [];
  for (const message of messages) {
    if (typeof message !== "string") continue;
    const stated: string[] = [];
    for (const sentence of sentences(message)) {
      if (/\b(?:if|whether|would|could|don't|do not|not using|not shooting)\b/i.test(sentence) || /\?/.test(sentence) && !/^\s*(?:actually\s+)?(?:I\b|I'm\b|my\b)/i.test(sentence)) continue;
      for (const match of sentence.matchAll(/\bmy\s+(.{1,60}?)\s+(?:camera(?:\s+body)?|body)\b/gi)) {
        const identity = clean(match[1]);
        if (identity && !generic.test(identity)) stated.push(identity);
      }
      for (const match of sentence.matchAll(/\b(?:my\s+(?:camera(?:\s+body)?|body)\s*(?:is|:)|I\s+(?:use|shoot\s+with|am\s+(?:using|shooting\s+with))|I'm\s+(?:using|shooting\s+with))\s+([^.!?,;]+)(?=[.!?,;]|$)/gi)) {
        for (const part of match[1].split(/\s+(?:for|with|on|but)\s+/i)[0].split(/\s+and\s+/i)) {
          const identity = clean(part);
          // Explicit device role is required; using Sony E glass is not a body.
          if (identity && !generic.test(identity) && !/\b(?:lens|lenses|mount|adapter|glass)\b/i.test(identity)) stated.push(identity);
        }
      }
    }
    if (stated.length) identities = [...new Set(stated)];
  }
  return identities;
}

/** A question can presuppose an identity just as an instruction can. This
 * validates the camera referent, independently of its technical properties. */
export function unsupportedRenterCameraClaims(text: string, messages: string[]): string[] {
  const identities = renterCameraIdentities(messages);
  const failures: string[] = [];
  for (const sentence of sentences(text)) {
    for (const match of sentence.matchAll(/\b(?:your|which|what)\s+(.{0,60}?)\b(?:camera(?:\s+body)?|body)\b/gi)) {
      const reference = clean(match[1]);
      if (!reference || generic.test(reference)) continue;
      const claim = normal(reference);
      // A stated exact model establishes its brand; a brand never establishes
      // a particular model. Token boundaries preserve FX3 versus FX30.
      const supported = identities.some(identity => {
        const words = identity.toLowerCase().split(/\s+/);
        return normal(identity) === claim || words.some((_, index) =>
          normal(words.slice(0, index + 1).join(" ")) === claim ||
          /\d/.test(claim) && normal(words.slice(index).join(" ")) === claim,
        );
      });
      if (!supported) failures.push(sentence.trim());
    }
  }
  return [...new Set(failures)];
}
