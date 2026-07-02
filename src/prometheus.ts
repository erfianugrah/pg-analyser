import { z } from "zod";
import type { TrendSeries } from "./schemas.ts";

/**
 * Optional 30-day trend panels, pulled from a Prometheus that scrapes the
 * project metrics endpoint (see `sbperf scrape-init`). The metrics endpoint
 * itself is point-in-time; real history only exists in a scraper's TSDB.
 */
const PANELS: Array<{ title: string; unit: string; query: string }> = [
  { title: "CPU load (1m)", unit: "", query: "avg(node_load1)" },
  { title: "Memory available", unit: "bytes", query: "avg(node_memory_MemAvailable_bytes)" },
  { title: "DB connections", unit: "", query: "sum(pg_stat_database_num_backends)" },
  {
    title: "Disk free (/data)",
    unit: "bytes",
    query: 'avg(node_filesystem_avail_bytes{mountpoint="/data"})',
  },
  { title: "Disk read IOPS", unit: "", query: "sum(rate(node_disk_reads_completed_total[5m]))" },
  { title: "Disk write IOPS", unit: "", query: "sum(rate(node_disk_writes_completed_total[5m]))" },
  { title: "Deadlocks", unit: "", query: "sum(pg_stat_database_deadlocks)" },
];

const RangeResponse = z.object({
  status: z.string(),
  data: z.object({
    result: z.array(z.object({ values: z.array(z.tuple([z.number(), z.string()])) })).default([]),
  }),
});

/** Fetch each panel's 30-day range from Prometheus. Skips panels with no data. */
export async function fetchTrends(baseUrl: string, days = 30): Promise<TrendSeries[]> {
  const end = Math.floor(Date.now() / 1000);
  const start = end - days * 86400;
  const step = Math.max(300, Math.floor((end - start) / 200)); // ~200 points max
  const base = baseUrl.replace(/\/+$/, "");

  const out: TrendSeries[] = [];
  for (const panel of PANELS) {
    const url = `${base}/api/v1/query_range?query=${encodeURIComponent(panel.query)}&start=${start}&end=${end}&step=${step}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`prometheus ${panel.query} -> ${res.status}`);
    const parsed = RangeResponse.parse(await res.json());
    const values = parsed.data.result[0]?.values ?? [];
    const points = values
      .map(([t, v]) => ({ t, v: Number(v) }))
      .filter((p) => Number.isFinite(p.v));
    if (points.length) out.push({ title: panel.title, unit: panel.unit, points });
  }
  return out;
}
