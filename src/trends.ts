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
export function computeTrends(input: SnapshotForTrends[]): TrendSeries[] {
  const snaps = [...input].sort((a, b) => a.ts - b.ts);
  if (!snaps.length) return [];

  const out: TrendSeries[] = [];
  const cpu = cpuUtilSeries(snaps);
  if (cpu) out.push(cpu);
  for (const g of GAUGES) {
    const series = gaugeSeries(snaps, g);
    if (series) out.push(series);
  }
  for (const r of RATES) {
    const series = rateSeries(snaps, r);
    if (series) out.push(series);
  }
  for (const sc of SCALARS) {
    const series = scalarSeries(snaps, sc);
    if (series) out.push(series);
  }
  return out;
}
