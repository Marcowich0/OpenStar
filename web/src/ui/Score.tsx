export interface ScoreProps {
  value: number;
  /** Size and weight utilities from the caller. */
  className?: string;
}

/** A Score, in tabular figures so the digits do not jump while it counts. */
export function Score({ value, className = "" }: ScoreProps) {
  return <span className={`tabular-nums ${className}`}>{value}</span>;
}
