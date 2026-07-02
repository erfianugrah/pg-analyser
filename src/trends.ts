import type { MetricSample, TrendSeries } from "./schemas.ts";

/**
 * One historical data point for trend computation: a timestamp plus the full
 * curated metric-sample set and the SQL-derived scalars captured at that time.
 * The store (store.ts) hydrates these from accumulated snapshots.
 */
export type SnapshotForTrends = {
  ts: number; // unix seconds
  samples: MetricSample[];
  scalars: Record<string, number | null>;
};

type TrendPoint = { t: number; v: number };

/** Default render cap - a sparkline is ~340px wide, so more points is wasted. */
const DEFAULT_MAX_POINTS = 300;

/**
 * Read-time downsampling, the way Grafana renders a wide time range: bucket the
 * points into <=maxPoints equal-time buckets and average value + time within
 * each. A single scrape resolution is preserved in the store; this only affects
 * what a trend series draws. No-op when already under the cap. Points are
 * assumed sorted by t ascending (computeTrends guarantees it).
 */
function downsample(points: TrendPoint[], maxPoints: number): TrendPoint[] {
  if (maxPoints < 1 || points.length <= maxPoints) return points;
  const tMin = points[0]!.t;
  const tMax = points[points.length - 1]!.t;
  const width = (tMax - tMin) / maxPoints || 1;
  const buckets = new Map<number, { tSum: number; vSum: number; n: number }>();
  for (const p of points) {
    const idx = Math.min(maxPoints - 1, Math.floor((p.t - tMin) / width));
    const b = buckets.get(idx) ?? { tSum: 0, vSum: 0, n: 0 };
    b.tSum += p.t;
    b.vSum += p.v;
    b.n += 1;
    buckets.set(idx, b);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, b]) => ({ t: Math.round(b.tSum / b.n), v: b.vSum / b.n }));
}

function matches(sample: MetricSample, filter?: Record<string, string>): boolean {
  if (!filter) return true;
  for (const k in filter) if (sample.labels[k] !== filter[k]) return false;
  return true;
}

/** Sum every sample of `name` (optionally label-filtered) in one snapshot. */
function sumOf(samples: MetricSample[], name: string, filter?: Record<string, string>): number {
  let total = 0;
  for (const s of samples) if (s.name === name && matches(s, filter)) total += s.value;
  return total;
}

/** True when at least one sample of `name` (optionally filtered) is present. */
function has(samples: MetricSample[], name: string, filter?: Record<string, string>): boolean {
  return samples.some((s) => s.name === name && matches(s, filter));
}

// --- Gauge series: aggregate matching samples per snapshot into one point. ---
// Gauges are meaningful from a single scrape, so one snapshot -> one point.

type GaugeDef = {
  title: string;
  unit: string;
  name: string;
  filter?: Record<string, string>;
  agg: "sum" | "avg";
};

const GAUGES: GaugeDef[] = [
  { title: "CPU load (1m)", unit: "", name: "node_load1", agg: "avg" },
  { title: "Memory available", unit: "bytes", name: "node_memory_MemAvailable_bytes", agg: "avg" },
  {
    title: "Disk free (/data)",
    unit: "bytes",
    name: "node_filesystem_avail_bytes",
    filter: { mountpoint: "/data" },
    agg: "avg",
  },
  { title: "DB connections", unit: "", name: "pg_stat_database_num_backends", agg: "sum" },
  { title: "Database size", unit: "bytes", name: "pg_database_size_bytes", agg: "sum" },
];

function gaugeSeries(snaps: SnapshotForTrends[], def: GaugeDef): TrendSeries | null {
  const points: TrendPoint[] = [];
  for (const snap of snaps) {
    if (!has(snap.samples, def.name, def.filter)) continue;
    const total = sumOf(snap.samples, def.name, def.filter);
    let v = total;
    if (def.agg === "avg") {
      const n = snap.samples.filter((s) => s.name === def.name && matches(s, def.filter)).length;
      v = n ? total / n : total;
    }
    points.push({ t: snap.ts, v });
  }
  return points.length ? { title: def.title, unit: def.unit, points } : null;
}

// --- Scalar series: SQL-derived numbers not present as metric samples. ---

type ScalarDef = { title: string; unit: string; key: string };

const SCALARS: ScalarDef[] = [
  { title: "Cache hit (%)", unit: "%", key: "cache_hit_pct" },
  { title: "Index hit (%)", unit: "%", key: "index_hit_pct" },
];

function scalarSeries(snaps: SnapshotForTrends[], def: ScalarDef): TrendSeries | null {
  const points: TrendPoint[] = [];
  for (const snap of snaps) {
    const v = snap.scalars[def.key];
    if (v == null || !Number.isFinite(v)) continue;
    points.push({ t: snap.ts, v });
  }
  return points.length ? { title: def.title, unit: def.unit, points } : null;
}

// --- Counter rate series: (delta of summed counter) / dt between snapshots. ---
// A single scrape of a counter is meaningless; a rate needs >=2 snapshots.
// Counter resets (later < earlier) drop that interval rather than spike.

type RateDef = { title: string; unit: string; name: string; scale?: number };

const RATES: RateDef[] = [
  { title: "Disk read IOPS", unit: "", name: "node_disk_reads_completed_total" },
  { title: "Disk write IOPS", unit: "", name: "node_disk_writes_completed_total" },
  { title: "Disk read (bytes/s)", unit: "bytes", name: "node_disk_read_bytes_total" },
  { title: "Disk write (bytes/s)", unit: "bytes", name: "node_disk_written_bytes_total" },
  { title: "Network RX (bytes/s)", unit: "bytes", name: "node_network_receive_bytes_total" },
  { title: "Network TX (bytes/s)", unit: "bytes", name: "node_network_transmit_bytes_total" },
];

function rateSeries(snaps: SnapshotForTrends[], def: RateDef): TrendSeries | null {
  const points: TrendPoint[] = [];
  for (let i = 1; i < snaps.length; i++) {
    const prev = snaps[i - 1]!;
    const cur = snaps[i]!;
    if (!has(prev.samples, def.name) || !has(cur.samples, def.name)) continue;
    const dt = cur.ts - prev.ts;
    if (dt <= 0) continue;
    const delta = sumOf(cur.samples, def.name) - sumOf(prev.samples, def.name);
    if (delta < 0) continue; // counter reset
    points.push({ t: cur.ts, v: (delta / dt) * (def.scale ?? 1) });
  }
  return points.length ? { title: def.title, unit: def.unit, points } : null;
}

/**
 * CPU utilization %: (1 - idleDelta/totalDelta) * 100 from node_cpu_seconds_total,
 * summed across all cpus. Idle time not spent is busy time. Clamped to 0..100.
 */
function cpuUtilSeries(snaps: SnapshotForTrends[]): TrendSeries | null {
  const name = "node_cpu_seconds_total";
  const points: TrendPoint[] = [];
  for (let i = 1; i < snaps.length; i++) {
    const prev = snaps[i - 1]!;
    const cur = snaps[i]!;
    if (!has(prev.samples, name) || !has(cur.samples, name)) continue;
    const idleDelta =
      sumOf(cur.samples, name, { mode: "idle" }) - sumOf(prev.samples, name, { mode: "idle" });
    const totalDelta = sumOf(cur.samples, name) - sumOf(prev.samples, name);
    if (totalDelta <= 0 || idleDelta < 0) continue; // no progress or reset
    const util = Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100));
    points.push({ t: cur.ts, v: util });
  }
  return points.length ? { title: "CPU utilization (%)", unit: "%", points } : null;
}

/**
 * Turn accumulated snapshots into renderable trend series. Gauges emit one
 * point per snapshot; counter-derived rates (IOPS, throughput, CPU%) emit one
 * point per consecutive interval. Series with no data are omitted entirely.
 */
export function computeTrends(
  input: SnapshotForTrends[],
  opts: { maxPoints?: number } = {},
): TrendSeries[] {
  const snaps = [...input].sort((a, b) => a.ts - b.ts);
  if (!snaps.length) return [];
  const maxPoints = opts.maxPoints ?? DEFAULT_MAX_POINTS;

  const out: TrendSeries[] = [];
  const push = (s: TrendSeries | null) => {
    if (s) out.push({ ...s, points: downsample(s.points, maxPoints) });
  };

  push(cpuUtilSeries(snaps));
  for (const g of GAUGES) push(gaugeSeries(snaps, g));
  for (const r of RATES) push(rateSeries(snaps, r));
  for (const sc of SCALARS) push(scalarSeries(snaps, sc));
  return out;
}
