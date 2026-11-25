/** The wait left as `m:ss` (`0:42`, `1:02`, `15:00`); never below `0:00`. */
export function formatWait(seconds: number): string {
  const whole = Math.max(0, Math.ceil(seconds));
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return `${String(minutes)}:${String(rest).padStart(2, "0")}`;
}
