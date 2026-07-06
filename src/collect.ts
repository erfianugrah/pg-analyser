import { log } from "./log.ts";
import { Management } from "./management.ts";
import { parsePrometheus } from "./metrics.ts";
import { fetchTrends } from "./prometheus.ts";
import { isUnwrappedAuth } from "./rls.ts";
import { type Analysis, MetricSample } from "./schemas.ts";
import { collectSplinterLints } from "./splinter.ts";
import { QUERIES } from "./sql.ts";
import { ManagementSqlRunner, type SqlRunner } from "./sqlrunner.ts";
import { computeSyncStatus } from "./sync.ts";
import type { Transport } from "./transport.ts";

type CollectError = { source: string; message: string };

/** Collect every plane for a project into one validated Analysis object. */
export async function collect(
  ref: string,
  transport: Transport | null,
  version: string,
  opts: {
    prometheusUrl?: string;
    prometheusToken?: string;
    prometheusCookie?: string;
    prometheusMatcher?: string;
    trendDays?: number;
    interval?: string;
    sqlRunner?: SqlRunner;
    syncCheck?: boolean;
    // No-PAT fallbacks: the human project name (from a --profile db entry) and
    // the AWS region (derived from the connstring). The Management API supplies
    // both in PAT mode; without it these are the only source, so a no-PAT
    // report can still show a real name/region instead of "ref (ref) - unknown".
    name?: string;
    region?: string;
  } = {},
): Promise<Analysis> {
  // No-PAT mode: transport == null. No Supabase Management API at all - a
  // superuser SQL runner (--db-url) is then REQUIRED, advisors come from the
  // self-hosted splinter lints, trends from Grafana (if configured). Every
  // Management plane is skipped rather than attempted-and-401'd.
  const m = transport ? new Management(transport) : null;
  const noPat = m === null;
  const errors: CollectError[] = [];
  const startedAt = performance.now();
  const clog = log.child({ ref, mode: noPat ? "no-pat" : "pat" });
  clog.info("collect start", { interval: opts.interval ?? "1day" });
  if (noPat && !opts.sqlRunner) {
    throw new Error(
      "no PAT (SUPABASE_ACCESS_TOKEN unset) and no superuser SQL runner: nothing to collect. " +
        "Provide a Personal Access Token, or a --db-url connstring for no-PAT db-url mode.",
    );
  }
  if (noPat) {
    errors.push({
      source: "management",
      message:
        "no PAT: Supabase Management API planes skipped (advisors via splinter, SQL via superuser --db-url, trends via Grafana if configured). Compute/disk provisioning, backups, pooler config, metrics and edge/API analytics are unavailable in this mode.",
    });
  }
  // Default SQL tier is the PAT read-only runner; --db-url injects a superuser
  // DirectSqlRunner. In no-PAT mode the injected superuser runner is the only
  // data source (guarded above).
  const runner: SqlRunner = opts.sqlRunner ?? new ManagementSqlRunner(m as Management, ref);
  // Timeframe for the analytics endpoints (API counts + edge-function stats).
  // The metrics scrape is point-in-time and SQL is cumulative-since-reset, so
  // this is the only query window Supabase lets us pick (max ~7 days).
  const interval = opts.interval ?? "1day";

  // Upstream sync check (on by default, soft-fail). Kicked off concurrently with
  // the plane fetches; computeSyncStatus never throws (offline -> skipped note).
  const syncP: Promise<Analysis["sync"]> =
    opts.syncCheck === false ? Promise.resolve(null) : computeSyncStatus();

  const safe = async <T>(source: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    const done = clog.time("plane", { source });
    try {
      const r = await fn();
      done({ ok: true });
      return r;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ source, message });
      done({ ok: false });
      clog.warn("plane failed", { source, error: message });
      return fallback;
    }
  };

  // Run a Management-API plane, or return its fallback unchanged in no-PAT mode
  // (no transport -> the plane is simply absent, no error recorded per-plane).
  const mgmt = <T>(source: string, fn: (mm: Management) => Promise<T>, fallback: T): Promise<T> =>
    m ? safe(source, () => fn(m), fallback) : Promise.resolve(fallback);

  // project meta is required in PAT mode; in no-PAT mode there is no Management
  // API to read it from, so meta is derived from the ref + SQL tier instead.
  const project = m
    ? await m.project(ref).catch((err) => {
        throw new Error(`cannot read project ${ref}: ${err instanceof Error ? err.message : err}`);
      })
    : null;

  const sql = (key: keyof typeof QUERIES) => safe(`sql:${key}`, () => runner.run(QUERIES[key]), []);

  const [
    health,
    disk,
    diskUtil,
    pgConfig,
    pooler,
    backups,
    upgrade,
    authConfig,
    networkRestrictions,
    sslEnforcement,
    functions,
    buckets,
    perfAdvisors,
    secAdvisors,
    apiCounts,
    dbSizeRows,
    cacheHitRows,
    statsResetRows,
    pgSettings,
    topStatements,
    topByCalls,
    queryIoStats,
    biggestTables,
    indexStats,
    duplicateIndexes,
    rlsUnindexed,
    seqScanHeavy,
    bloat,
    trafficProfile,
    deadTuples,
    txidWraparound,
    replicationSlots,
    rlsPolicies,
    connections,
    roleStats,
    longRunning,
    locks,
    blocking,
    storageUsage,
    extensions,
    unindexedVectors,
    bucketList,
    walArchiving,
    hbaRules,
    metricsText,
  ] = await Promise.all([
    mgmt("health", (mm) => mm.health(ref), []),
    mgmt("disk", (mm) => mm.disk(ref), null),
    mgmt("diskUtil", (mm) => mm.diskUtil(ref), null),
    mgmt("pgConfig", (mm) => mm.pgConfig(ref), null),
    mgmt("pooler", (mm) => mm.pooler(ref), null),
    mgmt("backups", (mm) => mm.backups(ref), null),
    mgmt("upgrade", (mm) => mm.upgrade(ref), null),
    mgmt("authConfig", (mm) => mm.authConfig(ref), null),
    mgmt("networkRestrictions", (mm) => mm.networkRestrictions(ref), null),
    mgmt("sslEnforcement", (mm) => mm.sslEnforcement(ref), null),
    mgmt("functions", (mm) => mm.functions(ref), []),
    mgmt("buckets", (mm) => mm.buckets(ref), []),
    mgmt("advisors:performance", (mm) => mm.advisors(ref, "performance"), []),
    mgmt("advisors:security", (mm) => mm.advisors(ref, "security"), []),
    mgmt("apiCounts", (mm) => mm.apiCounts(ref, interval), []),
    sql("dbSize"),
    sql("cacheHit"),
    sql("statsResetAge"),
    sql("pgSettings"),
    sql("topStatements"),
    sql("topByCalls"),
    sql("queryIoStats"),
    sql("biggestTables"),
    sql("indexStats"),
    sql("duplicateIndexes"),
    sql("rlsUnindexed"),
    sql("seqScanHeavy"),
    sql("bloat"),
    sql("trafficProfile"),
    sql("deadTuples"),
    sql("txidWraparound"),
    sql("replicationSlots"),
    sql("rlsPolicies"),
    sql("connections"),
    sql("roleStats"),
    sql("longRunning"),
    sql("locks"),
    sql("blocking"),
    sql("storageUsage"),
    sql("extensions"),
    sql("unindexedVectors"),
    sql("bucketList"),
    sql("walArchiving"),
    sql("hbaRules"),
    transport
      ? safe(
          "metrics",
          async () => {
            const res = await transport.metrics(ref);
            if (!res.ok) throw new Error(`metrics -> ${res.status}`);
            return await res.text();
          },
          null,
        )
      : Promise.resolve(null),
  ]);

  // Capture the FULL scrape - every family the endpoint serves, no curation.
  // The complete corpus is the product (node_exporter + postgres_exporter +
  // pgbouncer + supavisor + gotrue + realtime + postgREST + ...); the report
  // curates only at the display boundary (see report/render metricsTable), and
  // the history store keeps everything so any metric is trendable / analyzable
  // later. Nothing is dropped at collection.
  const samples = metricsText ? parsePrometheus(metricsText).map((s) => MetricSample.parse(s)) : [];
  // Auth + schema for an auth'd datasource (Grafana proxy / auth'd Prometheus or
  // Prometheus). Flag-provided (opts) wins; else the SBPERF_PROMETHEUS_*
  // env. token = service-account bearer; cookie = browser session (SSO-fronted
  // Grafana); matcher = project-label template for a non-default scraper schema.
  const promUrl = opts.prometheusUrl ?? process.env.SBPERF_PROMETHEUS_URL;
  const promToken = opts.prometheusToken ?? process.env.SBPERF_PROMETHEUS_TOKEN;
  const promCookie = opts.prometheusCookie ?? process.env.SBPERF_PROMETHEUS_COOKIE;
  const promMatcher = opts.prometheusMatcher ?? process.env.SBPERF_PROMETHEUS_MATCHER;
  // Trend query window (days). Grafana/Prometheus is a TSDB, so this can be well
  // past the ~7-day analytics cap - the dashboards go to 90d. Profile/opts wins,
  // then SBPERF_TREND_DAYS, then 30. Not internal - just a knob, so it's config.
  const envDays = Number(process.env.SBPERF_TREND_DAYS);
  const trendDays =
    opts.trendDays && opts.trendDays > 0
      ? opts.trendDays
      : Number.isFinite(envDays) && envDays > 0
        ? envDays
        : 30;
  const trends = promUrl
    ? await safe(
        "trends",
        () =>
          fetchTrends(promUrl, trendDays, ref, {
            token: promToken,
            cookie: promCookie,
            matcher: promMatcher,
          }),
        [],
      )
    : [];

  // Per-function invocation stats depend on the functions list (need each id),
  // so they run after the parallel batch. Best-effort per function.
  const functionStats: Analysis["functionStats"] = [];
  for (const fn of functions) {
    if (!m || !fn.id) continue;
    const id = fn.id;
    const resp = await safe(
      `functionStats:${fn.slug}`,
      () => m.functionStats(ref, id, interval),
      null,
    );
    const rows = resp?.result ?? [];
    if (!rows?.length) continue;
    const sum = (k: string) => rows.reduce((s, r) => s + Number(r[k] ?? 0), 0);
    const requests = sum("request_count");
    const weightedAvg =
      requests > 0
        ? rows.reduce(
            (s, r) => s + Number(r.avg_execution_time ?? 0) * Number(r.request_count ?? 0),
            0,
          ) / requests
        : 0;
    functionStats.push({
      slug: fn.slug,
      requests,
      success: sum("success_count"),
      clientErr: sum("client_err_count"),
      serverErr: sum("server_err_count"),
      avgExecMs: Math.round(weightedAvg),
      maxExecMs: rows.reduce((mx, r) => Math.max(mx, Number(r.max_execution_time ?? 0)), 0),
    });
  }

  // No-PAT fill-ins from SQL for planes the Management API would otherwise own.
  // Both are pure Postgres state the Management API is merely proxying, so a
  // superuser --db-url reaches them directly. In PAT mode the Management value
  // wins; these only fill the gap when the API plane is absent/empty.
  //  - pgConfig: /config/database/postgres returns the user-overridable GUC
  //    subset; pg_settings is the superset we already collect. Shape is a bare
  //    name -> value record either way.
  //  - buckets: /storage/buckets reads storage.buckets; bucketList is that table.
  const pgConfigResolved =
    pgConfig ??
    (pgSettings.length
      ? Object.fromEntries(pgSettings.map((r) => [String(r.name), r.setting]))
      : null);
  const bucketsResolved = buckets.length
    ? buckets
    : bucketList.map((r) => ({
        id: r.id == null ? undefined : String(r.id),
        name: String(r.name),
        public: typeof r.public === "boolean" ? r.public : undefined,
      }));

  const dbSize = (dbSizeRows[0]?.db_size as string | undefined) ?? null;
  const rawCacheHit = cacheHitRows[0]?.cache_hit_pct;
  const cacheHitPct = rawCacheHit == null ? null : Number(rawCacheHit);
  const rawBlksAccessed = cacheHitRows[0]?.heap_blks_accessed;
  const cacheBlocksAccessed =
    rawBlksAccessed == null || !Number.isFinite(Number(rawBlksAccessed))
      ? null
      : Number(rawBlksAccessed);
  const rawIndexHit = cacheHitRows[0]?.index_hit_pct;
  const indexHitPct = rawIndexHit == null ? null : Number(rawIndexHit);
  const statsResetAge = (statsResetRows[0]?.stats_age as string | undefined) ?? null;

  // The hosted advisors/performance endpoint currently 400s on the splinter
  // storage-buckets lint (42601, prepared-statement path). With a superuser
  // --db-url we run splinter ourselves over the simple-query protocol.
  // Classify RLS policies in JS from the captured qual/with_check (unit-tested,
  // case-correct) rather than an embedded regex.
  const rlsClassified = rlsPolicies.map((r) => ({
    ...r,
    unwrapped_auth: isUnwrappedAuth(r.qual as string | null, r.with_check as string | null),
  }));

  // Fill any advisor plane the hosted endpoint didn't provide from the
  // self-hosted splinter lints (run once, split by category). This is the
  // FALLBACK in PAT mode (the hosted advisors/performance endpoint 400s on the
  // storage-buckets lint) and the PRIMARY advisor source in no-PAT mode (both
  // planes empty -> both filled).
  let performanceAdvisors = perfAdvisors;
  let securityAdvisors = secAdvisors;
  if ((performanceAdvisors.length === 0 || securityAdvisors.length === 0) && runner.runMulti) {
    const all = await safe("advisors:splinter", () => collectSplinterLints(runner), []);
    if (performanceAdvisors.length === 0)
      performanceAdvisors = all.filter((l) => (l.categories ?? []).includes("PERFORMANCE"));
    if (securityAdvisors.length === 0)
      securityAdvisors = all.filter((l) => (l.categories ?? []).includes("SECURITY"));
  }

  const collectionMs = Math.round(performance.now() - startedAt);
  const analysis: Analysis = {
    meta: {
      ref,
      name: project?.name ?? opts.name ?? ref,
      collectionMs,
      region: project?.region ?? opts.region ?? "unknown",
      status: project?.status ?? "unknown",
      // PAT gives the platform version; no-PAT falls back to server_version from
      // pg_settings (SQL), so the report shows a version either way.
      pgVersion:
        project?.database?.version ??
        (pgSettings.find((r) => r.name === "server_version")?.setting as string | undefined) ??
        null,
      createdAt: project?.created_at ?? "",
      collectedAt: new Date().toISOString(),
      sbperfVersion: version,
      sqlSource: runner.source,
      managementApi: !noPat,
    },
    health,
    disk: disk
      ? {
          sizeGb: disk.attributes.size_gb,
          iops: disk.attributes.iops ?? null,
          type: disk.attributes.type ?? null,
          throughputMibps: disk.attributes.throughput_mibps ?? null,
          usedBytes: diskUtil?.metrics.fs_used_bytes ?? null,
          availBytes: diskUtil?.metrics.fs_avail_bytes ?? null,
        }
      : null,
    pgConfig: pgConfigResolved,
    pooler,
    backups,
    upgrade,
    functions,
    functionStats,
    buckets: bucketsResolved,
    // Security config planes - absent entirely in no-PAT mode (no Management
    // API). In PAT mode each sub-plane is whatever mgmt() resolved (null on a
    // per-endpoint 403/beta-gate, the parsed config otherwise).
    security: noPat ? null : { auth: authConfig, networkRestrictions, sslEnforcement },
    advisors: { performance: performanceAdvisors, security: securityAdvisors },
    apiCounts,
    sql: {
      dbSize,
      cacheHitPct: Number.isFinite(cacheHitPct) ? cacheHitPct : null,
      indexHitPct: indexHitPct != null && Number.isFinite(indexHitPct) ? indexHitPct : null,
      cacheBlocksAccessed,
      statsResetAge,
      pgSettings,
      topStatements,
      topByCalls,
      queryIoStats,
      biggestTables,
      indexStats,
      duplicateIndexes,
      rlsUnindexed,
      seqScanHeavy,
      bloat,
      trafficProfile,
      deadTuples,
      txidWraparound,
      replicationSlots,
      rlsPolicies: rlsClassified,
      connections,
      roleStats,
      longRunning,
      locks,
      blocking,
      storageUsage,
      extensions,
      unindexedVectors,
      walArchiving,
      hbaRules,
    },
    metrics: { available: metricsText != null, samples },
    trends,
    sync: await syncP,
    narrative: null,
    errors,
  };

  clog.info("collect done", {
    collectionMs,
    errors: errors.length,
    metrics: analysis.metrics.available,
    trends: trends.length,
    samples: samples.length,
  });
  return analysis;
}
