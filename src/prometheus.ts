import { z } from "zod";
import type { TrendSeries } from "./schemas.ts";

/**
 * Optional 30-day trend panels, pulled from a Prometheus that scrapes the
 * project metrics endpoint (see `sbperf scrape-init`). The metrics endpoint
 * itself is point-in-time; real history only exists in a scraper's TSDB.
 */
/**
 * Build the trend panel queries, each scoped to a single project when a ref is
 * given. A scraper Prometheus can hold MANY projects (see supabase-grafana's
 * multi-project mode), and every series carries a `supabase_project_ref` label,
 * so an unscoped `avg(node_load1)` would blend every scraped project together.
 * With `refMatcher` set, each metric selector is filtered to the one project;
 * with it empty, the queries are the original unscoped form (single-project
 * scraper, backward compatible).
 */
function buildPanels(refMatcher: string): Array<{ title: string; unit: string; query: string }> {
  const sel = (metric: string, ...extra: string[]): string => {
    const inner = [...extra, refMatcher].filter(Boolean).join(", ");
    return inner ? `${metric}{${inner}}` : metric;
  };
  return [
    { title: "CPU load (1m)", unit: "", query: `avg(${sel("node_load1")})` },
    {
      title: "Memory available",
      unit: "bytes",
      query: `avg(${sel("node_memory_MemAvailable_bytes")})`,
    },
    { title: "DB connections", unit: "", query: `sum(${sel("pg_stat_database_num_backends")})` },
    {
      title: "Disk free (/data)",
      unit: "bytes",
      query: `avg(${sel("node_filesystem_avail_bytes", 'mountpoint="/data"')})`,
    },
    {
      title: "Disk read IOPS",
      unit: "",
      query: `sum(rate(${sel("node_disk_reads_completed_total")}[5m]))`,
    },
    {
      title: "Disk write IOPS",
      unit: "",
      query: `sum(rate(${sel("node_disk_writes_completed_total")}[5m]))`,
    },
    { title: "Deadlocks", unit: "", query: `sum(${sel("pg_stat_database_deadlocks")})` },
  ];
}

const RangeResponse = z.object({
  status: z.string(),
  data: z.object({
    result: z.array(z.object({ values: z.array(z.tuple([z.number(), z.string()])) })).default([]),
  }),
});

/**
 * Fetch each panel's 30-day range from Prometheus. Skips panels with no data.
 * Pass `ref` to scope every query to one project when the Prometheus scrapes
 * more than one (otherwise the aggregates blend all scraped projects).
 */
export async function fetchTrends(
  baseUrl: string,
  days = 30,
  ref?: string,
): Promise<TrendSeries[]> {
  const end = Math.floor(Date.now() / 1000);
  const start = end - days * 86400;
  const step = Math.max(300, Math.floor((end - start) / 200)); // ~200 points max
  const base = baseUrl.replace(/\/+$/, "");
  const panels = buildPanels(ref ? `supabase_project_ref="${ref}"` : "");

  const out: TrendSeries[] = [];
  for (const panel of panels) {
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
