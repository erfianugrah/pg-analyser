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
  agg: "sum" | "avg" | "max";
};

// Raw node_load1 / MemAvailable / DiskFree gauges were retired in favour of the
// utilization-% series below (memUsedPct / diskUsedPct / cpuUtil) so the store
// path charts the same readable panels as the Prometheus path (prometheus.ts).
const GAUGES: GaugeDef[] = [
  { title: "DB connections", unit: "", name: "pg_stat_database_num_backends", agg: "sum" },
  { title: "Database size", unit: "bytes", name: "pg_database_size_bytes", agg: "sum" },
  // EBS burst balance (%): a gauge; AWS gp2/gp3 throttle when credits deplete.
  // Present only when a CloudWatch-scraping source feeds the store; absent -> omitted.
  {
    title: "EBS IOPS balance (%)",
    unit: "%",
    name: "aws_ec2_ebsiobalance_percent_minimum",
    agg: "avg",
  },
  {
    title: "EBS throughput balance (%)",
    unit: "%",
    name: "aws_ec2_ebsbyte_balance_percent_minimum",
    agg: "avg",
  },
  // WAL files waiting to be archived. Sustained > 0 = archival falling behind
  // (PITR / backup risk). A gauge - meaningful from a single scrape.
  {
    title: "WAL files pending archival",
    unit: "",
    name: "pg_ls_archive_statusdir_wal_pending_count",
    agg: "max",
  },
];

function gaugeSeries(snaps: SnapshotForTrends[], def: GaugeDef): TrendSeries | null {
  const points: TrendPoint[] = [];
  for (const snap of snaps) {
    if (!has(snap.samples, def.name, def.filter)) continue;
    const matching = snap.samples.filter((s) => s.name === def.name && matches(s, def.filter));
    const total = sumOf(snap.samples, def.name, def.filter);
    let v = total;
    if (def.agg === "avg") v = matching.length ? total / matching.length : total;
    else if (def.agg === "max") v = matching.length ? Math.max(...matching.map((s) => s.value)) : 0;
    points.push({ t: snap.ts, v });
  }
  return points.length ? { title: def.title, unit: def.unit, points } : null;
}

// --- Scalar series: SQL-derived numbers not present as metric samples. ---

type ScalarDef = { title: string; unit: string; key: string };

const SCALARS: ScalarDef[] = [
  { title: "Cache hit (%)", unit: "%", key: "cache_hit_pct" },
  { title: "Index hit (%)", unit: "%", key: "index_hit_pct" },
  // SQL-derived (no metric equivalent), so store-path only - the Grafana path
  // has no per-slot lag family. In no-PAT+Grafana slot growth degrades to the
  // point-in-time slot findings; here it becomes a trendable growth signal.
  { title: "Slot WAL retained (max, bytes)", unit: "bytes", key: "slot_wal_retained_max_bytes" },
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
  { title: "Transaction rate (/s)", unit: "", name: "pg_stat_database_xact_commit_total" },
  { title: "Disk read IOPS", unit: "", name: "node_disk_reads_completed_total" },
  { title: "Disk write IOPS", unit: "", name: "node_disk_writes_completed_total" },
  { title: "Disk read (bytes/s)", unit: "bytes", name: "node_disk_read_bytes_total" },
  { title: "Disk write (bytes/s)", unit: "bytes", name: "node_disk_written_bytes_total" },
  { title: "Network RX (bytes/s)", unit: "bytes", name: "node_network_receive_bytes_total" },
  { title: "Network TX (bytes/s)", unit: "bytes", name: "node_network_transmit_bytes_total" },
  { title: "Temp file bytes/s", unit: "bytes", name: "pg_stat_database_temp_bytes_total" },
  { title: "Deadlocks/s", unit: "", name: "pg_stat_database_deadlocks_total" },
  // Checkpoints: `requested` (forced because WAL filled) vs `timed` (the regular
  // checkpoint_timeout interval). A high requested share = raise max_wal_size.
  {
    title: "Requested checkpoints/s",
    unit: "",
    name: "pg_stat_bgwriter_checkpoints_req_total",
  },
  { title: "Timed checkpoints/s", unit: "", name: "pg_stat_bgwriter_checkpoints_timed_total" },
  // Memory-pressure evidence (rate; a snapshot of MemAvailable can't see it).
  { title: "Major page faults/s", unit: "", name: "node_vmstat_pgmajfault" },
  { title: "Swap-in pages/s", unit: "", name: "node_vmstat_pswpin" },
  // OOM killer events (rate; any nonzero = memory was exhausted and a process
  // was killed - a stronger signal than a high memory %).
  { title: "OOM kills/s", unit: "", name: "node_vmstat_oom_kill" },
  // PSI stall %: rate of the *_waiting_seconds_total counter is a fraction of
  // time (0-1); scale to a percent. Same titles as the Prometheus panels.
  {
    title: "CPU stall (PSI %)",
    unit: "%",
    name: "node_pressure_cpu_waiting_seconds_total",
    scale: 100,
  },
  {
    title: "Memory stall (PSI %)",
    unit: "%",
    name: "node_pressure_memory_waiting_seconds_total",
    scale: 100,
  },
  {
    title: "I/O stall (PSI %)",
    unit: "%",
    name: "node_pressure_io_waiting_seconds_total",
    scale: 100,
  },
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
 * Memory used % = (1 - MemAvailable/MemTotal) * 100 per snapshot. Computed gauge
 * (two metrics); mirrors the Prometheus panel of the same title.
 */
function memUsedPctSeries(snaps: SnapshotForTrends[]): TrendSeries | null {
  const points: TrendPoint[] = [];
  for (const snap of snaps) {
    if (!has(snap.samples, "node_memory_MemTotal_bytes")) continue;
    const total = sumOf(snap.samples, "node_memory_MemTotal_bytes");
    const avail = sumOf(snap.samples, "node_memory_MemAvailable_bytes");
    if (total <= 0) continue;
    points.push({ t: snap.ts, v: Math.max(0, Math.min(100, (1 - avail / total) * 100)) });
  }
  return points.length ? { title: "Memory used (%)", unit: "%", points } : null;
}

/**
 * Disk used % on /data = (1 - avail/size) * 100 per snapshot. Computed gauge;
 * mirrors the Prometheus panel of the same title.
 */
function fsUsedPctSeries(
  snaps: SnapshotForTrends[],
  mountpoint: string,
  title: string,
): TrendSeries | null {
  const f = { mountpoint };
  const points: TrendPoint[] = [];
  for (const snap of snaps) {
    if (!has(snap.samples, "node_filesystem_size_bytes", f)) continue;
    const size = sumOf(snap.samples, "node_filesystem_size_bytes", f);
    const avail = sumOf(snap.samples, "node_filesystem_avail_bytes", f);
    if (size <= 0) continue;
    points.push({ t: snap.ts, v: Math.max(0, Math.min(100, (1 - avail / size) * 100)) });
  }
  return points.length ? { title, unit: "%", points } : null;
}

/**
 * Provisioned filesystem size (bytes) on a mountpoint, per snapshot. The
 * absolute size the fsUsedPct ratio hides - needed to detect a volume RESIZE (a
 * step-change in the denominator) and to project fill against real bytes rather
 * than the % (which resets on every expansion).
 */
function fsSizeSeries(
  snaps: SnapshotForTrends[],
  mountpoint: string,
  title: string,
): TrendSeries | null {
  const f = { mountpoint };
  const points: TrendPoint[] = [];
  for (const snap of snaps) {
    if (!has(snap.samples, "node_filesystem_size_bytes", f)) continue;
    points.push({ t: snap.ts, v: sumOf(snap.samples, "node_filesystem_size_bytes", f) });
  }
  return points.length ? { title, unit: "bytes", points } : null;
}

/**
 * Swap used = SwapTotal - SwapFree, per snapshot. A computed gauge (two
 * metrics), so it doesn't fit the single-name GaugeDef path. Swap in use is a
 * memory-pressure signal - each project has ~1GB swap and swapping is disk I/O.
 */
function swapUsedSeries(snaps: SnapshotForTrends[]): TrendSeries | null {
  const points: TrendPoint[] = [];
  for (const snap of snaps) {
    if (!has(snap.samples, "node_memory_SwapTotal_bytes")) continue;
    const used =
      sumOf(snap.samples, "node_memory_SwapTotal_bytes") -
      sumOf(snap.samples, "node_memory_SwapFree_bytes");
    points.push({ t: snap.ts, v: Math.max(0, used) });
  }
  return points.length ? { title: "Swap used", unit: "bytes", points } : null;
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
  push(memUsedPctSeries(snaps));
  push(fsUsedPctSeries(snaps, "/data", "Disk used (%)"));
  push(fsUsedPctSeries(snaps, "/", "Root FS used (%)"));
  push(fsSizeSeries(snaps, "/data", "Disk size (bytes)"));
  push(swapUsedSeries(snaps));
  for (const g of GAUGES) push(gaugeSeries(snaps, g));
  for (const r of RATES) push(rateSeries(snaps, r));
  for (const sc of SCALARS) push(scalarSeries(snaps, sc));
  return out;
}
