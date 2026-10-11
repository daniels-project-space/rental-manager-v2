import styles from "./CalendarGantt.module.css";

export type CalendarClockStatus = "confirmed" | "reported" | "missing";
export type HandoverBlock = {
  start_date?: string;
  end_date?: string;
  return_date?: string | null;
  pickup_time?: string | null;
  return_time?: string | null;
  pickup_time_status?: CalendarClockStatus;
  return_time_status?: CalendarClockStatus;
  order_step?: string | null;
};
export function calendarDayLabel(day?: string | null) {
  return day
    ? new Date(day + "T12:00Z").toLocaleDateString("en-GB", {
        weekday: "short",
        day: "numeric",
        month: "short",
        timeZone: "UTC",
      })
    : "Date not recorded";
}
export function CalendarHandoverSummary({ block }: { block: HandoverBlock }) {
  return (
    <div className={styles.handover} data-calendar-handover>
      {(["pickup", "return"] as const).map((endpoint) => {
        const day =
          endpoint === "pickup"
            ? block.start_date
            : (block.return_date ?? block.end_date);
        const time =
          endpoint === "pickup" ? block.pickup_time : block.return_time;
        const status =
          endpoint === "pickup"
            ? block.pickup_time_status
            : block.return_time_status;
        return (
          <div
            key={endpoint}
            className={
              endpoint === "return" ? styles.returnMoment : styles.pickupMoment
            }
            data-calendar-moment={endpoint}
          >
            <span className={styles.momentLabel}>
              {endpoint === "return" ? "↓ Return" : "↑ Pickup"}
            </span>
            <span className={styles.momentDate}>{calendarDayLabel(day)}</span>
            <strong className={styles.momentTime}>
              {time?.slice(0, 5) ?? "Time not recorded"}
            </strong>
            {time && (
              <span className={styles.evidence}>
                {status === "confirmed"
                  ? "Confirmed"
                  : "Reported · not confirmed"}
              </span>
            )}
            {!time && (
              <span className={styles.evidence}>
                Date recorded · exact time unknown
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
