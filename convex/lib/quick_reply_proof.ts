type Detail = {
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
  const verified = steps.some(
    (s) => s.key === "VERIFIED" && s.completed === true && !s.failure,
  );
  const begun =
    paid &&
    steps.some(
      (s) => s.key === "VERIFIED" && (s.active || s.completed) && !s.failure,
    );
  const events = (detail.activities ?? [])
    .filter((a) => !a.chatMessage)
    .map((a) => `${a.event?.title ?? ""} ${a.event?.content ?? ""}`);
  const confirmation = events.some(
    (text) =>
      !/not |failed|rejected|cancelled|will be|once /i.test(text) &&
      /(?:rental|booking|borrower).{0,70}(?:confirmed|booked|passed (?:our )?(?:security|verification) checks)|(?:passed (?:our )?(?:security|verification) checks).{0,70}(?:rental|booking|borrower)/i.test(
        text,
      ),
  );
  return {
    paid,
    verification_started: begun,
    platform_booking_confirmed: paid && verified && confirmation,
  };
}
