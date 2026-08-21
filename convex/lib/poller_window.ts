/** London [07:00, 23:00) is the deliberate active polling window. */
const ACTIVE_WINDOW_START_MIN = 7 * 60;
const ACTIVE_WINDOW_END_MIN = 23 * 60;

export function isWithinActivePollingWindow(londonMinutes: number): boolean {
  return londonMinutes >= ACTIVE_WINDOW_START_MIN && londonMinutes < ACTIVE_WINDOW_END_MIN;
}
