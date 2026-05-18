/**
 * ──────────────────────────────────────────────────────────────────────────
 *  Denial Classifier — Phase 3a (audit_reclassification.md §1 + §2)
 *
 *  Pure-function module. NO Convex db handles. NO side effects.
 *
 *  Inputs:  obsolete reservation signals + (optional) cached chat regex hits.
 *  Output:  one of Daniel's 4 canonical outcomes + confidence + signal label.
 *
 *  41-row decision matrix is implemented as an explicit cascade. Each branch
 *  returns a signal label that maps 1:1 to a matrix row group, so observability
 *  is preserved end-to-end.
 *
 *  Important production note: `auditClassificationCoverage` showed
 *  `order_step == null` for ALL 190 obsolete reservations in prod. The
 *  classifier therefore relies primarily on
 *  `obsolete_reason × gross_paid_gbp × last_message_sender × days_since`,
 *  with `order_step` as an optional refinement.
 * ──────────────────────────────────────────────────────────────────────────
 */

/** Daniel's 4 canonical denial outcomes. */
export type DenialOutcome =
  | "owner_denied"
  | "renter_ghosted"
  | "renter_cancelled_explicit"
  | "system_or_other";

export type Confidence = "high" | "medium" | "low";

export type LastMessageSender = "me" | "renter" | "none";

/** Input to the classifier — purely derived from the reservation row
 *  + last chat-message lookup. No Convex types here. */
export type ClassifierInput = {
  obsolete_reason?: string | null;
  /** Hygglo funnel step at last poll. NULL in ~all of prod (Feb 2026). */
  order_step?: string | null;
  gross_paid_gbp?: number | null;
  /** Sender of the LATEST hygglo_messages row (thread_id == hygglo_order_id). */
  last_message_sender?: LastMessageSender;
  last_message_at?: number | null;
  /** Best-effort timestamp when the row became obsolete (max of
   *  _creationTime, demand_loss_classified_at, etc.). Used for days-since. */
  obsolete_at?: number | null;
  /** Pre-computed regex hits (callers run regex against last 5 messages). */
  chat_owner_cancel_hit?: boolean;
  chat_renter_cancel_hit?: boolean;
  chat_owner_approval_hit?: boolean;
  /** Phase 3d — derived from Hygglo `activity.event.content` (platform-canonical
   *  "blue text"). Highest-priority signal in the cascade: when present and
   *  decisive, it overrides chat regex hits. */
  hygglo_system_signal?:
    | "owner_denied"
    | "renter_cancelled"
    | "auto_cancelled"
    | "verification_failed"
    | "approved"
    | "none"
    | null;
};

export type ClassifierOutput = {
  outcome: DenialOutcome;
  confidence: Confidence;
  /** Human-readable rule label (e.g. "obsolete_reason=owner_denied+no_chat_conflict"). */
  signal: string;
};

// ──────────────────────────────────────────────────────────────────────────
// Chat regex patterns (audit §2A / §2B / §2C — verbatim from the audit doc)
// Exported so the reclassifier mutation can scan hygglo_messages once and
// pass pre-computed hit booleans to classifyDenialActor.
// ──────────────────────────────────────────────────────────────────────────

/** OWNER cancelled — Daniel's messages (sender === "owner"). */
export const OWNER_CANCEL_RE =
  /\b(can(?:'|no)?t(?:\s+do|\s+rent|\s+make)|cannot|unable|not\s+available|unavailable|already\s+(?:booked|rented|out)|double[-\s]?book|broken|not\s+working|damaged|sorry[, ].{0,40}(?:can(?:'|no)?t|unable|not\s+able)|have\s+to\s+cancel|need\s+to\s+cancel|I[' ]?m?\s+cancel{1,2}ing|won't\s+work\s+for\s+me)\b/i;

/** RENTER cancelled — renter's messages (sender === "renter"). */
export const RENTER_CANCEL_RE =
  /\b(don'?t\s+need\s+(?:it|this|anymore)|no\s+longer\s+need|cancel(?:l?ed|l?ing|l?ation)?|refund|changed\s+my\s+mind|found\s+(?:another|elsewhere|cheaper)|going\s+with\s+(?:someone|another)|sorry[, ].{0,40}(?:not\s+anymore|changed|don'?t\s+need|cancel)|won'?t\s+need|not\s+needed\s+anymore)\b/i;

/** OWNER approval — used to detect ghosting structurally
 *  ("I approved, they vanished"). */
export const OWNER_APPROVAL_RE =
  /\b(approved|go\s+ahead|yes,?\s+(?:please\s+)?(?:proceed|continue|book)|confirmed|works\s+for\s+me|sounds\s+good|see\s+you|pick\s*up\s+(?:at|on)|✅|👍)\b/i;

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

/** Days between `last_message_at` and `obsolete_at` (or now). Returns -1 if
 *  either timestamp is missing. */
function daysSinceLastMessage(input: ClassifierInput): number {
  if (input.last_message_at == null) return -1;
  const ref = input.obsolete_at ?? Date.now();
  return Math.max(0, (ref - input.last_message_at) / DAY_MS);
}

function paidPositive(input: ClassifierInput): boolean {
  return (input.gross_paid_gbp ?? 0) > 0;
}

// ──────────────────────────────────────────────────────────────────────────
// Main classifier — explicit cascade over the 41-row matrix.
// Precedence (audit §2D):
//   1. Strong chat signal (OWNER_CANCEL_RE on owner msg) → owner_denied
//   2. Strong chat signal (RENTER_CANCEL_RE on renter msg) → renter_cancelled_explicit
//   3. Structural cascade per obsolete_reason / paid / last_msg / days
//   4. Default → system_or_other low
// ──────────────────────────────────────────────────────────────────────────
export function classifyDenialActor(input: ClassifierInput): ClassifierOutput {
  const reason = (input.obsolete_reason ?? "").toLowerCase() || null;
  const paid = paidPositive(input);
  const sender = input.last_message_sender ?? "none";
  const days = daysSinceLastMessage(input);
  const step = (input.order_step ?? "").toUpperCase() || null;
  const sysSignal = input.hygglo_system_signal ?? null;

  // ── 0. Hygglo system-event ground truth (Phase 3d — HIGHEST priority) ─
  // Platform-canonical "blue text" emitted only when Hygglo's UI button was
  // pressed (or a system auto-action fired). Cannot be faked by chat — lives
  // on activity.event, not activity.chatMessage. Overrides chat regex.
  if (sysSignal === "owner_denied") {
    return {
      outcome: "owner_denied",
      confidence: "high",
      signal: "hygglo_system_event=owner_denied",
    };
  }
  if (sysSignal === "renter_cancelled") {
    return {
      outcome: "renter_cancelled_explicit",
      confidence: "high",
      signal: "hygglo_system_event=renter_cancelled",
    };
  }
  if (sysSignal === "auto_cancelled") {
    return {
      outcome: "system_or_other",
      confidence: "high",
      signal: "hygglo_system_event=auto_cancelled",
    };
  }
  if (sysSignal === "verification_failed") {
    return {
      outcome: "system_or_other",
      confidence: "high",
      signal: "hygglo_system_event=verification_failed",
    };
  }
  // sysSignal === "approved" is non-decisive — fall through to chat/structural
  // rules but enable the renter_ghosted detection below.

  // ── 0b. Stage-aware structural ground truth (Phase 3d) ───────────────
  // These fire when sysSignal is absent ("none"/null) but order_step pins
  // funnel-stage truth. Run BEFORE chat regex so they short-circuit a noisy
  // chat thread that contradicts the funnel state.
  if (step === "CANCELED" && reason === "renter_cancelled") {
    return {
      outcome: "renter_cancelled_explicit",
      confidence: "high",
      signal: "order_step=CANCELED+reason=renter_cancelled",
    };
  }
  if (step === "VERIFICATION_FAILED") {
    return {
      outcome: "system_or_other",
      confidence: "high",
      signal: "order_step=VERIFICATION_FAILED",
    };
  }
  if (step === "REQUEST" && sender !== "renter") {
    // Never accepted, renter hasn't poked again — owner denied (implicit
    // or explicit). Days-since-last-message bumps confidence.
    return {
      outcome: "owner_denied",
      confidence: days >= 3 ? "high" : "medium",
      signal: "order_step=REQUEST+no_renter_followup",
    };
  }
  // Phase 3d — renter_ghosted detection: Hygglo says "approved", but renter
  // never paid and the latest message was Daniel's (and it's been a while).
  if (
    sysSignal === "approved" &&
    !paid &&
    sender === "me" &&
    days >= 7
  ) {
    return {
      outcome: "renter_ghosted",
      confidence: "high",
      signal: "hygglo_system_event=approved+unpaid+sender=me+days>=7",
    };
  }

  // ── 0. Chat signal precedence (audit §2D) ────────────────────────────
  // Only override structural classification when chat hits agree with the
  // sender direction (owner-cancel pattern must come from an owner msg, etc).
  // The reclassifier passes pre-computed hits that already enforce sender
  // direction during the message scan.
  if (input.chat_owner_cancel_hit) {
    return {
      outcome: "owner_denied",
      confidence: "high",
      signal: "chat:owner_cancel_re",
    };
  }
  if (input.chat_renter_cancel_hit) {
    return {
      outcome: "renter_cancelled_explicit",
      confidence: "high",
      signal: "chat:renter_cancel_re",
    };
  }

  // ── 1A. obsolete_reason = "owner_denied" (audit §1A) ─────────────────
  if (reason === "owner_denied") {
    // Row 1-3: paid=0, last_msg=me → owner denied (Daniel sent denial).
    if (!paid && sender === "me") {
      return {
        outcome: "owner_denied",
        confidence: "high",
        signal: "obsolete_reason=owner_denied+sender=me",
      };
    }
    // Row 4-6: paid=0, last_msg=renter → renter ghosted (renter asked, no progression).
    if (!paid && sender === "renter") {
      return {
        outcome: "renter_ghosted",
        confidence: days >= 3 ? "high" : "medium",
        signal: "obsolete_reason=owner_denied+sender=renter (no owner reply)",
      };
    }
    // Row 7: paid=0, no messages → system_or_other.
    if (!paid && sender === "none") {
      return {
        outcome: "system_or_other",
        confidence: "low",
        signal: "obsolete_reason=owner_denied+no_messages",
      };
    }
    // Row 8: paid>0 with reason=owner_denied — data anomaly.
    return {
      outcome: "system_or_other",
      confidence: "low",
      signal: "obsolete_reason=owner_denied+paid_anomaly",
    };
  }

  // ── 1B. obsolete_reason = "renter_cancelled" (audit §1B) ─────────────
  if (reason === "renter_cancelled") {
    // Row 9-11: paid>0 + last_msg=renter → explicit cancellation (refunded).
    if (paid && sender === "renter") {
      return {
        outcome: "renter_cancelled_explicit",
        confidence: "high",
        signal: "obsolete_reason=renter_cancelled+paid+sender=renter",
      };
    }
    // Row 12-14: paid>0 + last_msg=me → likely owner_denied (Daniel cancelled
    // paid booking and refunded). Med confidence without chat regex hit.
    if (paid && sender === "me") {
      return {
        outcome: "owner_denied",
        confidence: "medium",
        signal: "obsolete_reason=renter_cancelled+paid+sender=me",
      };
    }
    // Row 15: paid>0, no msgs → manual review.
    if (paid && sender === "none") {
      return {
        outcome: "system_or_other",
        confidence: "low",
        signal: "obsolete_reason=renter_cancelled+paid+no_messages",
      };
    }
    // Row 16-18: paid=0 + last_msg=renter → renter_ghosted (with days≥3 high).
    // Row 16 with days<3 is ambiguous but resolves to renter_ghosted absent chat.
    if (!paid && sender === "renter") {
      return {
        outcome: "renter_ghosted",
        confidence: days >= 3 ? "high" : "medium",
        signal: "obsolete_reason=renter_cancelled+unpaid+sender=renter",
      };
    }
    // Row 19-20: paid=0 + last_msg=me → renter_ghosted (Daniel sent
    // approval/follow-up, renter never paid).
    if (!paid && sender === "me") {
      return {
        outcome: "renter_ghosted",
        confidence: "high",
        signal: "obsolete_reason=renter_cancelled+unpaid+sender=me (ghosted_after_owner_action)",
      };
    }
    // Row 21-22: paid=0, no msgs.
    return {
      outcome: "renter_ghosted",
      confidence: "low",
      signal: "obsolete_reason=renter_cancelled+unpaid+no_messages",
    };
  }

  // ── 1C. obsolete_reason = "verification_failed" (audit §1C) ──────────
  if (reason === "verification_failed") {
    // Row 26-28: FUNDS_RESERVED + paid=0 → renter_ghosted (renter never funded escrow).
    if (!paid && (step === "FUNDS_RESERVED" || step === null)) {
      // No step in prod → use paid+sender to differentiate from system_or_other.
      if (sender === "me" || sender === "renter") {
        return {
          outcome: "renter_ghosted",
          confidence: step === "FUNDS_RESERVED" ? "high" : "medium",
          signal: step
            ? `obsolete_reason=verification_failed+step=${step}+unpaid (renter never funded)`
            : "obsolete_reason=verification_failed+unpaid+has_messages",
        };
      }
    }
    // Row 23-25 (and default): Hygglo ID/doc step failed → system_or_other.
    return {
      outcome: "system_or_other",
      confidence: "high",
      signal: "obsolete_reason=verification_failed",
    };
  }

  // ── 1D. obsolete_reason = "other" (audit §1D) ────────────────────────
  if (reason === "other") {
    // Row 29: BOOKED_AFTER_VERIFIED + paid>0 → renter_cancelled_explicit OR
    // owner_denied. Without chat keyword we lean owner_denied (med).
    if (paid && step === "BOOKED_AFTER_VERIFIED") {
      return {
        outcome: "owner_denied",
        confidence: "medium",
        signal: "obsolete_reason=other+step=BOOKED_AFTER_VERIFIED+paid",
      };
    }
    // Row 34-38: APPROVED + paid=0 → renter_ghosted (textbook ghost-after-approval).
    if (!paid && step === "APPROVED") {
      return {
        outcome: "renter_ghosted",
        confidence: sender === "none" ? "medium" : "high",
        signal: "obsolete_reason=other+step=APPROVED+unpaid (ghost_after_approval)",
      };
    }
    // No-step / null-step cases (the prod reality — order_step is null
    // for 100% of obsolete rows). Lean on paid + sender.
    // Row equivalent: paid>0 + chat_owner_cancel (caught above), else paid>0
    // + sender=me likely owner_denied (med); paid=0 + sender=me +days≥7 → ghosted.
    if (paid && sender === "me") {
      return {
        outcome: "owner_denied",
        confidence: "medium",
        signal: "obsolete_reason=other+paid+sender=me",
      };
    }
    if (paid && sender === "renter") {
      return {
        outcome: "renter_cancelled_explicit",
        confidence: "medium",
        signal: "obsolete_reason=other+paid+sender=renter",
      };
    }
    if (!paid && sender === "me" && days >= 7) {
      return {
        outcome: "renter_ghosted",
        confidence: "medium",
        signal: "obsolete_reason=other+unpaid+sender=me+days>=7 (ghost_after_owner_msg)",
      };
    }
    if (!paid && sender === "renter") {
      return {
        outcome: "renter_ghosted",
        confidence: "low",
        signal: "obsolete_reason=other+unpaid+sender=renter",
      };
    }
    // Row 30-33, 40: anomalies / no messages.
    return {
      outcome: "system_or_other",
      confidence: "low",
      signal: "obsolete_reason=other+no_clear_signal",
    };
  }

  // ── 1E. obsolete_reason = undefined / unknown (audit §1E, row 41) ────
  // Daniel's note: order_step is null for ALL obsolete rows in prod, so the
  // structural fallback when obsolete_reason is missing AND status is
  // "cancelled" or "declined" needs explicit handling.
  if (!reason) {
    if (!paid && sender === "me") {
      return {
        outcome: "renter_ghosted",
        confidence: "low",
        signal: "no_reason+unpaid+sender=me",
      };
    }
    return {
      outcome: "system_or_other",
      confidence: "low",
      signal: "no_obsolete_reason",
    };
  }

  // ── Default: system_or_other low ─────────────────────────────────────
  return {
    outcome: "system_or_other",
    confidence: "low",
    signal: `default_fallback(reason=${reason ?? "null"})`,
  };
}
