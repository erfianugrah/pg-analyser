/**
 * Contention-episode detection (Check 2 of the lock-contention plan). Pure
 * functions over the native-resolution IncidentSeries fetched by
 * prometheus.fetchIncidentSeries. A mass-cancellation event shows as a
 * synchronized burst across transaction rollbacks, active backends, and
 * share-lock counts; this detects those bursts, merges adjacent hot buckets
 * into episodes, and attributes which series correlated.
 *
 * The gate is relative (k x median over nonzero buckets) with an absolute
 * floor, so a chatty app with a high baseline rollback rate does not trip it -
 * only a burst well above its OWN median does.
 */
import type { IncidentSeries } from "./prometheus.ts";

export type Episode = {
  from: number;
  to: number;
  /** Which series were hot in this episode (rollbacks / activeBackends / accessShare). */
  series: string[];
  rollbackTotal: number;
  peakActive: number;
};

type SeriesCfg = { absFloor: number; k: number; minConsecutive: number };

const CFG: Record<"rollbacks" | "activeBackends" | "accessShare", SeriesCfg> = {
  rollbacks: { absFloor: 20, k: 6, minConsecutive: 1 },
  activeBackends: { absFloor: 10, k: 4, minConsecutive: 2 },
  accessShare: { absFloor: 0, k: 4, minConsecutive: 1 },
};

/** Median over nonzero values (baseline for the relative gate). */
function median(xs: number[]): number {
  const nz = xs.filter((v) => v > 0).sort((a, b) => a - b);
  if (nz.length === 0) return 0;
  const m = Math.floor(nz.length / 2);
  return nz.length % 2 ? nz[m]! : (nz[m - 1]! + nz[m]!) / 2;
}

/** Indices of buckets that exceed max(absFloor, k*median) for minConsecutive in a row. */
function hotBuckets(pts: Array<[number, number]> | undefined, c: SeriesCfg): Set<number> {
  const hot = new Set<number>();
  if (!pts || pts.length === 0) return hot;
  const thr = Math.max(c.absFloor, c.k * median(pts.map((p) => p[1])));
  let run = 0;
  for (let i = 0; i < pts.length; i++) {
    if (pts[i]![1] > thr) {
      run++;
      if (run >= c.minConsecutive) for (let j = i - run + 1; j <= i; j++) hot.add(j);
    } else {
      run = 0;
    }
  }
  return hot;
}

export function detectEpisodes(s: IncidentSeries): Episode[] {
  const perSeries: Record<string, Set<number>> = {
    rollbacks: hotBuckets(s.rollbacks, CFG.rollbacks),
    activeBackends: hotBuckets(s.activeBackends, CFG.activeBackends),
    accessShare: hotBuckets(s.accessShare, CFG.accessShare),
  };
  // Union of hot indices -> merge adjacent (gap <= 1) -> attribute series.
  const allHot = [...new Set(Object.values(perSeries).flatMap((set) => [...set]))].sort(
    (a, b) => a - b,
  );
  if (allHot.length === 0) return [];
  const merged: number[][] = [];
  for (const idx of allHot) {
    const last = merged.at(-1);
    if (last && idx - last.at(-1)! <= 1) last.push(idx);
    else merged.push([idx]);
  }
  const tAt = (i: number) =>
    s.rollbacks?.[i]?.[0] ??
    s.activeBackends?.[i]?.[0] ??
    s.accessShare?.[i]?.[0] ??
    s.windowFrom + i * s.stepSec;
  return merged.map((idxs) => {
    const series = Object.entries(perSeries)
      .filter(([, set]) => idxs.some((i) => set.has(i)))
      .map(([k]) => k);
    const rollbackTotal = idxs.reduce((sum, i) => sum + (s.rollbacks?.[i]?.[1] ?? 0), 0);
    const peakActive = Math.max(0, ...idxs.map((i) => s.activeBackends?.[i]?.[1] ?? 0));
    return { from: tAt(idxs[0]!), to: tAt(idxs.at(-1)!), series, rollbackTotal, peakActive };
  });
}
