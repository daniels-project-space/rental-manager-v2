/**
 * renter_bot_tone_scorer — ported from V1's QualityScorerService
 * (rental-manager/src/evaluation/quality-scorer.service.ts:203-277), same
 * regex heuristics, rewritten as plain functions since V2 is serverless
 * Convex (no NestJS DI here). Test-only, used by the harness rubric — not
 * imported by production draft-generation code.
 */

export interface ToneScore {
  score: number | null;
  account_slug: string;
  reason?: string; // set when score is null
}

// Ported verbatim from QualityScorerService.scoreDBCinemaTone.
function scoreDBCinemaTone(text: string): number {
  let score = 0.7;
  const professionalMarkers = [
    /\b(confirmed|verified|booking|available|location|address)\b/i,
    /\bhttps?:\/\//i,
    /\d{1,2}(am|pm|-\d{1,2}(am|pm))/i,
  ];
  for (const marker of professionalMarkers) if (marker.test(text)) score += 0.05;
  const wordCount = text.split(/\s+/).length;
  if (wordCount >= 30 && wordCount <= 120) score += 0.1;
  if (/\b(cool|awesome|dude|mate|gonna|wanna|btw)\b/i.test(text)) score -= 0.15;
  if (/\b(as per|kindly note|hereby|furthermore|moreover)\b/i.test(text)) score -= 0.1;
  return Math.max(0, Math.min(1, score));
}

// Ported verbatim from QualityScorerService.scoreLeoAdamsTone.
function scoreLeoAdamsTone(text: string): number {
  let score = 0.7;
  const friendlyMarkers = [
    /\b(hey|thanks|thx|cheers|sounds good|no worries|let me know)\b/i,
    /\b(I'll|I'm|I'd)\b/,
  ];
  for (const marker of friendlyMarkers) if (marker.test(text)) score += 0.07;
  if (/\b(cool|great|perfect|nice|awesome)\b/i.test(text)) score += 0.08;
  if (/\b(kindly|hereby|as per|furthermore|please be advised)\b/i.test(text)) score -= 0.15;
  if (/\b(lol|lmao|bruh|dude|innit)\b/i.test(text)) score -= 0.2;
  return Math.max(0, Math.min(1, score));
}

// Diogo has no seeded tone rule anywhere in the codebase today — it's an open
// question in docs/renter-bot-policy.md, not something to invent heuristics
// for. Returns null rather than a fabricated score.
function scoreDiogoTone(_text: string): null {
  return null;
}

// Real account_slug values (confirmed in convex/lib/reservations/accounts.ts) —
// NOT "daniel"/"leo"/"diogo" for the first one, it's "dbcinema_web".
const SCORERS: Record<string, (text: string) => number | null> = {
  dbcinema_web: scoreDBCinemaTone,
  leo: scoreLeoAdamsTone,
  diogo: scoreDiogoTone,
};

export function scoreTone(accountSlug: string, text: string): ToneScore {
  const fn = SCORERS[accountSlug];
  if (!fn) {
    return {
      score: null,
      account_slug: accountSlug,
      reason: `No tone scorer registered for account "${accountSlug}".`,
    };
  }
  const score = fn(text);
  if (score === null) {
    return {
      score: null,
      account_slug: accountSlug,
      reason:
        "No tone rule defined for this account yet — open question in docs/renter-bot-policy.md, not invented here.",
    };
  }
  return { score, account_slug: accountSlug };
}
