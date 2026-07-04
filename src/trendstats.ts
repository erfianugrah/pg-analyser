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
  direction: "rising" | "falling" | "flat";
};

/** Enough data to trust a trend? Default: >=12 points spanning >=3 days. */
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

  // Least-squares slope of value vs time-in-days.
  let slopePerDay = 0;
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
  }

  // Direction: only call it rising/falling if the drift over the window is a
  // meaningful fraction of the observed range (else it's noise -> flat).
  const drift = slopePerDay * spanDays;
  const range = max - min || Math.abs(mean) || 1;
  const dir = drift / range;
  const direction = dir > 0.1 ? "rising" : dir < -0.1 ? "falling" : "flat";

  return { n, spanDays, first, last, min, max, mean, p95, slopePerDay, direction };
}

/** Fraction of points at/above (dir '>=') or at/below (dir '<=') a threshold. */
export function sustainedFrac(points: Point[], threshold: number, dir: ">=" | "<="): number {
  if (points.length === 0) return 0;
  const hit = points.filter((p) => (dir === ">=" ? p.v >= threshold : p.v <= threshold)).length;
  return hit / points.length;
}

/**
 * Days until the trend reaches `target`, extrapolating the current slope from
 * the last value. Null when the slope isn't moving toward the target (flat, or
 * heading away) - i.e. no meaningful projection.
 */
export function projectDaysTo(stat: TrendStat, target: number): number | null {
  const gap = target - stat.last;
  if (stat.slopePerDay === 0) return null;
  const days = gap / stat.slopePerDay;
  return days > 0 && Number.isFinite(days) ? days : null;
}

/** Convenience: pull a series's points from an Analysis by title. */
export function pointsOf(trends: TrendSeries[], title: string): Point[] {
  return trends.find((t) => t.title === title)?.points ?? [];
}
