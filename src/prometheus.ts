import { z } from "zod";
import type { TrendSeries } from "./schemas.ts";

/**
 * Optional 30-day trend panels, pulled from a Prometheus that scrapes the
 * project metrics endpoint (see `sbperf scrape-init`). The metrics endpoint
 * itself is point-in-time; real history only exists in a scraper's TSDB.
 *
 * A scraper Prometheus can hold MANY projects and every series carries a
 * `supabase_project_ref` label, so an unscoped `avg(node_load1)` would blend
 * every scraped project together. `refMatcher` scopes each selector to one
 * project; empty = unscoped (single-project scraper, backward compatible).
 */
/** A single trend panel: display title, Grafana-style unit, and its PromQL. The
 * one source of truth shared by the report trends (fetchTrends) and the
 * clean-room Grafana dashboard scrape-init ships - so both render the same set.
 */
export type TrendPanel = { title: string; unit: string; query: string };

/**
 * Build the trend panel specs, each scoped to a project via `refMatcher`
 * (`supabase_project_ref="<ref>"` for the report, `supabase_project_ref="$project"`
 * for the Grafana dashboard's template var). Empty matcher = unscoped.
 */
export function buildPanels(refMatcher: string): TrendPanel[] {
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
  // Auto-scope to the real data span: a young project (created days ago) or a
  // freshly-started scraper has no data across most of a 30/90-day window, so a
  // fixed step smears a handful of points across mostly-empty time. Re-query
  // [dataStart, now] so the step gives full resolution over the span that
  // actually exists. No created_at needed (no-PAT has none).
  //
  // dataStart comes from an explicit probe (min_over_time(timestamp(...))) NOT
  // from pass 1's first points: over a 30d window pass 1's step is ~13000s, so
  // for an hour-old scrape it returns a single tail point at ~now, making the
  // inferred span ~0 - the re-scope would never fire and every panel collapses
  // to one flat point. The probe finds the true earliest sample regardless of
  // the outer step. Falls back to the pass-1 inference if the probe fails.
  const inferred = series.flatMap((s) => (s.points.length ? [s.points[0]!.t] : []));
  const probed = await probeDataStart(base, refMatcher, end, days, reqInit).catch(() => null);
  const dataStart = probed ?? (inferred.length ? Math.min(...inferred) : null);
  if (dataStart != null) {
    const spanDays = (end - dataStart) / 86400;
    if (spanDays > 0 && spanDays < days * 0.6)
      series = await queryWindow(base, panels, Math.floor(dataStart), end, reqInit, refMatcher);
  }
  return series;
}

const InstantResponse = z.object({
  status: z.string(),
  data: z.object({ result: z.array(z.object({ value: z.tuple([z.number(), z.string()]) })) }),
});

/**
 * Find the real earliest-sample timestamp (unix seconds) for this project via an
 * instant `min(min_over_time(timestamp(<probe>)[<days>d:<res>]))` query. This is
 * robust to a coarse outer step (a 30d range step of ~13000s misses that data
 * only started an hour ago), so the caller can re-scope to the span that exists.
 * Uses node_load1 - a metric every node_exporter target emits. Returns null when
 * the probe yields no series (metric/matcher mismatch) so the caller falls back.
 */
async function probeDataStart(
  base: string,
  refMatcher: string,
  end: number,
  days: number,
  reqInit: RequestInit,
): Promise<number | null> {
  const sel = refMatcher ? `node_load1{${refMatcher}}` : "node_load1";
  const res = days <= 2 ? "5m" : "1h";
  const query = `min(min_over_time(timestamp(${sel})[${Math.ceil(days)}d:${res}]))`;
  const url = `${base}/api/v1/query?query=${encodeURIComponent(query)}&time=${end}`;
  const r = await fetch(url, reqInit);
  if (!r.ok) return null;
  const parsed = InstantResponse.parse(await r.json());
  if (parsed.status !== "success") return null;
  const v = parsed.data.result[0]?.value[1];
  if (v === undefined) return null;
  const t = Number(v);
  return Number.isFinite(t) && t > 0 ? t : null;
}

/** Fetch every panel over [start, end] at a ~200-point step. Throws (for the
 * caller's safe() to record) on auth redirect, non-JSON, a query error, or when
 * every panel returns 0 series (matcher/ref mismatch). */
async function queryWindow(
  base: string,
  panels: TrendPanel[],
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
