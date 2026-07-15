import type { TrendSeries } from "./schemas.ts";

/**
 * Trend-analysis primitives. These turn a time series into the shapes a
 * suggestion needs - slope (growth), sustained-fraction (chronic vs bursty),
 * peak, and projection - as opposed to the point/mean helpers in findings.ts.
 *
 * DATA-AWARE by design: `sufficient()` gates every trend finding so we never
 * claim "sustained X over 30d" from one snapshot. Grafana (90d, ~200 pts)
 * clears the gate instantly; a 2-point store series does not, so trend findings
 * stay dormant on a PAT-only run until enough snapshots accrue.
 */

export type Point = { t: number; v: number };

/**
 * Minimum |drift| as a fraction of the observed range for a series to count as
 * rising/falling rather than flat. Drift within +/-10% of the range is treated
 * as noise - a hand-tuned floor, not a significance test (a slope confidence
 * interval would be more defensible; documented here so the constant is named).
 */
export const DIRECTION_MIN_DRIFT_FRACTION = 0.1;

export type TrendStat = {
  n: number;
  spanDays: number;
  first: number;
  last: number;
  min: number;
  max: number;
  mean: number;
  p95: number;
  /** Linear-regression slope in units per DAY. */
  slopePerDay: number;
  /**
   * The fitted regression value at the last observation (intercept + slope*x_last).
   * Projections anchor on THIS, not the raw `last`, so a noisy final sample does
   * not swing days-to-full.
   */
  fittedLast: number;
  direction: "rising" | "falling" | "flat";
};

/**
 * Enough data to trust a trend? Default: >=12 points spanning >=3 days. The
 * 12/3 floor is a pragmatic guard (roughly two snapshots/day for ~a week, or a
 * Grafana window), chosen so a 2-point store series stays dormant rather than
 * claiming "sustained over 30d" - not a statistically derived power threshold.
 */
export function sufficient(points: Point[], minPoints = 12, minDays = 3): boolean {
  if (points.length < minPoints) return false;
  const span = (points[points.length - 1]!.t - points[0]!.t) / 86400;
  return span >= minDays;
}

const quantile = (sortedAsc: number[], q: number): number => {
  if (sortedAsc.length === 0) return 0;
  const i = Math.min(sortedAsc.length - 1, Math.max(0, Math.floor(q * (sortedAsc.length - 1))));
  return sortedAsc[i]!;
};

export function trendStat(points: Point[]): TrendStat | null {
  const n = points.length;
  if (n === 0) return null;
  const vs = points.map((p) => p.v);
  const ts = points.map((p) => p.t);
  const first = vs[0]!;
  const last = vs[n - 1]!;
  const min = Math.min(...vs);
  const max = Math.max(...vs);
  const mean = vs.reduce((a, b) => a + b, 0) / n;
  const p95 = quantile(
    [...vs].sort((a, b) => a - b),
    0.95,
  );

  const spanSec = ts[n - 1]! - ts[0]!;
  const spanDays = spanSec / 86400;

  // Least-squares slope of value vs time-in-days, plus the fitted value at the
  // last x (the regression's estimate of "where we are now", robust to a noisy
  // final sample - projectDaysTo anchors on this rather than the raw last point).
  let slopePerDay = 0;
  let fittedLast = last;
  if (n >= 2 && spanSec > 0) {
    const t0 = ts[0]!;
    const xs = ts.map((t) => (t - t0) / 86400);
    const xm = xs.reduce((a, b) => a + b, 0) / n;
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
      num += (xs[i]! - xm) * (vs[i]! - mean);
      den += (xs[i]! - xm) ** 2;
    }
    slopePerDay = den > 0 ? num / den : 0;
    fittedLast = mean + slopePerDay * (xs[n - 1]! - xm);
  }

  // Direction: only call it rising/falling if the drift over the window is a
  // meaningful fraction of the observed range (else it's noise -> flat).
  const drift = slopePerDay * spanDays;
  const range = max - min || Math.abs(mean) || 1;
  const dir = drift / range;
  const direction =
    dir > DIRECTION_MIN_DRIFT_FRACTION
      ? "rising"
      : dir < -DIRECTION_MIN_DRIFT_FRACTION
        ? "falling"
        : "flat";

  return { n, spanDays, first, last, min, max, mean, p95, slopePerDay, fittedLast, direction };
}

/** Fraction of points at/above (dir '>=') or at/below (dir '<=') a threshold. */
export function sustainedFrac(points: Point[], threshold: number, dir: ">=" | "<="): number {
  if (points.length === 0) return 0;
  const hit = points.filter((p) => (dir === ">=" ? p.v >= threshold : p.v <= threshold)).length;
  return hit / points.length;
}

/**
 * Days until the trend reaches `target`, extrapolating the current slope from
 * the FITTED value at the last point (not the raw last sample, which may be an
 * outlier). Null when the slope isn't moving toward the target (flat, or
 * heading away) - i.e. no meaningful projection.
 */
export function projectDaysTo(stat: TrendStat, target: number): number | null {
  const gap = target - stat.fittedLast;
  if (stat.slopePerDay === 0) return null;
  const days = gap / stat.slopePerDay;
  return days > 0 && Number.isFinite(days) ? days : null;
}

/** Convenience: pull a series's points from an Analysis by title. */
export function pointsOf(trends: TrendSeries[], title: string): Point[] {
  return trends.find((t) => t.title === title)?.points ?? [];
}

export type ResizeEvent = { at: number; fromBytes: number; toBytes: number };

/**
 * Detect step-changes (volume resizes) in a size series: consecutive points
 * where the value jumps by >= `minStepFrac` of the earlier value. Returns each
 * event in time order (usually 0 or 1). Catches both expansions and shrinks;
 * the caller decides which direction it cares about. A resize makes "% used"
 * meaningless across the boundary (the denominator changed), so callers use
 * this to segment the series before projecting.
 */
export function detectResizes(points: Point[], minStepFrac: number): ResizeEvent[] {
  const events: ResizeEvent[] = [];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]!.v;
    const cur = points[i]!.v;
    if (prev > 0 && Math.abs(cur - prev) / prev >= minStepFrac) {
      events.push({ at: points[i]!.t, fromBytes: prev, toBytes: cur });
    }
  }
  return events;
}
