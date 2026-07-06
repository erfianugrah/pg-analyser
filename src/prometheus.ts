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
  const rate5 = (metric: string, ...extra: string[]): string =>
    `rate(${sel(metric, ...extra)}[5m])`;
  // Utilization %/rates over raw values - a 30-day view of "load 0.4" / "7.4GB
  // free" reads far worse than "CPU 26%" / "disk 4% full". These are the standard
  // node_exporter + postgres_exporter panels a Grafana infra dashboard charts,
  // plus optional cloudwatch_exporter EBS burst-balance (present only if the
  // Prometheus also scrapes AWS CloudWatch). Titles + semantics match the store-
  // backed computeTrends (trends.ts) so the report looks the same either way.
  return [
    {
      title: "CPU utilization (%)",
      unit: "%",
      query: `clamp_min(100 - (avg(${rate5("node_cpu_seconds_total", 'mode="idle"')}) * 100), 0)`,
    },
    {
      title: "Memory used (%)",
      unit: "%",
      query: `(1 - avg(${sel("node_memory_MemAvailable_bytes")}) / avg(${sel("node_memory_MemTotal_bytes")})) * 100`,
    },
    {
      title: "Disk used (%)",
      unit: "%",
      query: `100 - (avg(${sel("node_filesystem_avail_bytes", 'mountpoint="/data"')}) * 100 / avg(${sel("node_filesystem_size_bytes", 'mountpoint="/data"')}))`,
    },
    {
      title: "Root FS used (%)",
      unit: "%",
      query: `100 - (avg(${sel("node_filesystem_avail_bytes", 'mountpoint="/"', 'fstype!="rootfs"')}) * 100 / avg(${sel("node_filesystem_size_bytes", 'mountpoint="/"', 'fstype!="rootfs"')}))`,
    },
    { title: "Database size", unit: "bytes", query: `sum(${sel("pg_database_size_bytes")})` },
    { title: "DB connections", unit: "", query: `sum(${sel("pg_stat_database_num_backends")})` },
    {
      title: "Transaction rate (/s)",
      unit: "",
      query: `sum(${rate5("pg_stat_database_xact_commit_total")})`,
    },
    {
      title: "Cache hit (%)",
      unit: "%",
      query: `sum(${rate5("pg_stat_database_blks_hit_total")}) / (sum(${rate5("pg_stat_database_blks_hit_total")}) + sum(${rate5("pg_stat_database_blks_read_total")})) * 100`,
    },
    {
      title: "Disk read IOPS",
      unit: "",
      query: `sum(${rate5("node_disk_reads_completed_total")})`,
    },
    {
      title: "Disk write IOPS",
      unit: "",
      query: `sum(${rate5("node_disk_writes_completed_total")})`,
    },
    { title: "Deadlocks/s", unit: "", query: `sum(${rate5("pg_stat_database_deadlocks_total")})` },
    // Checkpoints: requested (WAL filled before the interval) vs timed (regular
    // checkpoint_timeout). A high requested share -> raise max_wal_size.
    {
      title: "Requested checkpoints/s",
      unit: "",
      query: `sum(${rate5("pg_stat_bgwriter_checkpoints_req_total")})`,
    },
    {
      title: "Timed checkpoints/s",
      unit: "",
      query: `sum(${rate5("pg_stat_bgwriter_checkpoints_timed_total")})`,
    },
    // WAL files waiting to be archived - sustained > 0 = archival lagging
    // (PITR / backup risk).
    {
      title: "WAL files pending archival",
      unit: "",
      query: `max(${sel("pg_ls_archive_statusdir_wal_pending_count")})`,
    },
    // Memory-pressure evidence: sustained major page faults / swap-in mean the
    // working set doesn't fit RAM (invisible to a MemAvailable snapshot).
    { title: "Major page faults/s", unit: "", query: `sum(${rate5("node_vmstat_pgmajfault")})` },
    { title: "Swap-in pages/s", unit: "", query: `sum(${rate5("node_vmstat_pswpin")})` },
    // PSI (Linux /proc/pressure): fraction of time tasks stalled waiting on a
    // resource, as a %. The truest saturation signal - a CPU-idle or
    // MemAvailable snapshot can read healthy while work is stalling.
    {
      title: "CPU stall (PSI %)",
      unit: "%",
      query: `avg(${rate5("node_pressure_cpu_waiting_seconds_total")}) * 100`,
    },
    {
      title: "Memory stall (PSI %)",
      unit: "%",
      query: `avg(${rate5("node_pressure_memory_waiting_seconds_total")}) * 100`,
    },
    {
      title: "I/O stall (PSI %)",
      unit: "%",
      query: `avg(${rate5("node_pressure_io_waiting_seconds_total")}) * 100`,
    },
    // OOM killer firing means memory was genuinely exhausted (a far stronger
    // signal than a high memory %); any nonzero rate = kills happened.
    { title: "OOM kills/s", unit: "", query: `sum(${rate5("node_vmstat_oom_kill")})` },
    // EBS burst balance (%): AWS gp2/gp3 throttle HARD when I/O or throughput
    // credits deplete - a latency cliff invisible to in-guest metrics. Lower =
    // worse; min() picks the worst instance.
    {
      title: "EBS IOPS balance (%)",
      unit: "%",
      query: `min(${sel("aws_ec2_ebsiobalance_percent_minimum")})`,
    },
    {
      title: "EBS throughput balance (%)",
      unit: "%",
      query: `min(${sel("aws_ec2_ebsbyte_balance_percent_minimum")})`,
    },
  ];
}

const RangeResponse = z.object({
  status: z.string(),
  error: z.string().optional(),
  errorType: z.string().optional(),
  data: z
    .object({
      result: z.array(z.object({ values: z.array(z.tuple([z.number(), z.string()])) })).default([]),
    })
    .optional(),
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
  opts: { token?: string; cookie?: string; matcher?: string } = {},
): Promise<TrendSeries[]> {
  const end = Math.floor(Date.now() / 1000);
  const base = baseUrl.replace(/\/+$/, "");
  // Project matcher template. Default = the self-scrape schema
  // (`supabase_project_ref="<ref>"`, one label per project). A scraper that
  // relabels series under a different project-identifying label overrides via
  // `matcher` (--prometheus-matcher / SBPERF_PROMETHEUS_MATCHER); "{ref}" is
  // substituted with the project ref. No ref -> unscoped (single-project scraper).
  const template = opts.matcher ?? 'supabase_project_ref="{ref}"';
  const refMatcher = ref ? template.replaceAll("{ref}", ref) : "";
  const panels = buildPanels(refMatcher);
  // Auth for a datasource fronted by Grafana. A service-account bearer TOKEN is
  // the documented path (Grafana proxy /api/datasources/proxy/uid/<uid>, or any
  // auth'd Prometheus). When Grafana sits behind an SSO proxy that a token can't
  // traverse, the browser session COOKIE (the same auth the dashboard uses) is
  // the only header that gets through. Token
  // wins if both are set. No auth -> no header (backward compatible).
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  else if (opts.cookie) headers.Cookie = opts.cookie;
  const init: RequestInit | undefined = Object.keys(headers).length > 0 ? { headers } : undefined;
  // Don't silently follow a redirect to an SSO login page - a 3xx means the
  // cookie/token didn't authenticate, and following it yields a 200 HTML page
  // that only fails later at JSON parse with a confusing error.
  const reqInit: RequestInit = { ...(init ?? {}), redirect: "manual" };

  // Pass 1: the requested window.
  let series = await queryWindow(base, panels, end - days * 86400, end, reqInit, refMatcher);
  // Auto-scope to the real data span: a young project (created days ago) has no
  // data across most of a 30/90-day window, so a fixed step smears a handful of
  // points across mostly-empty time. Detect where data actually starts and, if
  // it fills well under the requested window, re-query [dataStart, now] so the
  // step gives full resolution over the span that exists. No created_at needed
  // (no-PAT has none) - inferred from the returned series.
  const starts = series.flatMap((s) => (s.points.length ? [s.points[0]!.t] : []));
  if (starts.length) {
    const dataStart = Math.min(...starts);
    const spanDays = (end - dataStart) / 86400;
    if (spanDays > 0 && spanDays < days * 0.6)
      series = await queryWindow(base, panels, Math.floor(dataStart), end, reqInit, refMatcher);
  }
  return series;
}

/** Fetch every panel over [start, end] at a ~200-point step. Throws (for the
 * caller's safe() to record) on auth redirect, non-JSON, a query error, or when
 * every panel returns 0 series (matcher/ref mismatch). */
async function queryWindow(
  base: string,
  panels: Array<{ title: string; unit: string; query: string }>,
  start: number,
  end: number,
  reqInit: RequestInit,
  refMatcher: string,
): Promise<TrendSeries[]> {
  const step = Math.max(300, Math.floor((end - start) / 200));
  const out: TrendSeries[] = [];
  let emptyPanels = 0;
  for (const panel of panels) {
    const url = `${base}/api/v1/query_range?query=${encodeURIComponent(panel.query)}&start=${start}&end=${end}&step=${step}`;
    const res = await fetch(url, reqInit);
    // Auth failure: a datasource behind an SSO proxy 3xx-redirects an
    // unauthenticated request to the IdP. Surface it clearly - it aborts every
    // panel identically, so fail fast on the first with an actionable message.
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location") ?? "";
      throw new Error(
        `datasource redirected (HTTP ${res.status}${loc.includes("accounts.google") || loc.includes("/oauth2/") ? " to SSO login" : ""}) - the session cookie/token is missing or expired for this datasource`,
      );
    }
    if (!res.ok) {
      const body = (await res.text()).replace(/\s+/g, " ").slice(0, 200);
      throw new Error(`datasource HTTP ${res.status} for "${panel.title}": ${body}`);
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      const body = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
      throw new Error(
        `datasource returned non-JSON for "${panel.title}" (an HTML login page? check auth): ${body}`,
      );
    }
    const parsed = RangeResponse.parse(json);
    // Prometheus/Grafana signals a query error in a 200 body (status:"error").
    if (parsed.status !== "success")
      throw new Error(
        `datasource query error for "${panel.title}": ${parsed.error ?? parsed.status}`,
      );
    const values = parsed.data?.result[0]?.values ?? [];
    const points = values
      .map(([t, v]) => ({ t, v: Number(v) }))
      .filter((p) => Number.isFinite(p.v));
    if (points.length) out.push({ title: panel.title, unit: panel.unit, points });
    else emptyPanels++;
  }
  // Reachable + authenticated but EVERY panel matched zero series -> almost
  // always a matcher/ref/region mismatch, not "no data". Fail loud so the caller
  // records it (silent empty trends is the #1 confusing failure).
  if (out.length === 0 && emptyPanels > 0)
    throw new Error(
      `datasource reachable but all ${emptyPanels} panels returned 0 series - the matcher "${refMatcher || "(none)"}" likely doesn't match this project's labels (check the ref, region, and datasource)`,
    );
  return out;
}
