import { isDead, isVerified } from "../order_step_semantics";
type Detail = {
  isBookedAndReady?: boolean;
  steps?: Array<{
    key: string;
    active?: boolean;
    completed?: boolean;
    failure?: boolean;
  }>;
  activities?: Array<{
    chatMessage?: unknown;
    event?: { content?: string; title?: string };
  }>;
};
export function quickReplyProof(detail: Detail) {
  const steps = detail.steps ?? [];
  const paid =
    steps.some(
      (s) => s.key === "FUNDS_RESERVED" && s.completed === true && !s.failure,
    ) ||
    steps.some(
      (s) =>
        [
          "VERIFIED",
          "BOOKED_AFTER_VERIFIED",
          "DELIVERED",
          "RETURNED",
          "REVIEWED",
        ].includes(s.key) &&
        (s.active || s.completed) &&
        !s.failure,
    );
  const current = steps.find(s => s.active);
  const active = current?.key;
  const booked = active ? isVerified(active) : steps.some(s => isVerified(s.key) && s.completed === true && !s.failure);
  const closed = current?.failure === true || isDead(active) || steps.some(s => isDead(s.key) && (s.active || s.completed));
  const verified = booked || steps.some(
    (s) => s.key === "VERIFIED" && s.completed === true && !s.failure,
  );
  const begun =
    paid &&
    (booked || steps.some(
      (s) => s.key === "VERIFIED" && (s.active || s.completed) && !s.failure,
    ));
  const events = (detail.activities ?? [])
    .filter((a) => !a.chatMessage)
    .map((a) => `${a.event?.title ?? ""} ${a.event?.content ?? ""}`);
  const confirmation = events.some(
    (text) =>
      !/not |failed|rejected|cancelled|will be|once /i.test(text) &&
      /(?:everything is booked and ready)|(?:rental|booking|borrower).{0,70}(?:confirmed|booked|passed (?:our )?(?:security|verification) checks)|(?:passed (?:our )?(?:security|verification) checks).{0,70}(?:rental|booking|borrower)/i.test(
        text,
      ),
  );
  return {
    paid,
    verification_started: begun,
    // Current post-verification workflow is platform evidence in its own
    // right. Hygglo need not repeat a particular English event phrase.
    platform_booking_confirmed: !closed && paid && verified &&
      (booked || detail.isBookedAndReady === true || confirmation) &&
      (!active || isVerified(active)),
  };
}
