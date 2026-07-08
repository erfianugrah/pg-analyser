import { type Logger, log } from "./log.ts";
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
    // Logger to use for this collection. Defaults to the process-wide `log`.
    // A multi-project sweep injects a quieter (warn-floor) logger so routine
    // per-plane INFO doesn't clutter the progress bar; single runs use info.
    logger?: Logger;
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
  const clog = (opts.logger ?? log).child({ ref, mode: noPat ? "no-pat" : "pat" });
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
      done({ ok: false });
      const expectedAbsence = /(relation|schema) "[^"]+" does not exist/i.test(message);
      if (expectedAbsence) {
        // Optional feature simply not present on this DB (pg_cron, storage, the
        // vector type, ... on a non-Supabase / extension-less database). The
        // finding + positive derivation already handle empty data, so this is a
        // debug log and NOT a collection note - surfacing "relation X does not
        // exist" in the report reads like a failure when nothing went wrong.
        clog.debug("plane absent", { source, error: message });
      } else {
        errors.push({ source, message });
        clog.warn("plane failed", { source, error: message });
      }
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

  // A paused / not-yet-up project has no live database or metrics endpoint:
  // every SQL query hits a connection timeout (544) and the metrics scrape has
  // no service_role, so fanning out all ~19 DB-dependent planes just yields a
  // per-plane warn each (and burns the connection-timeout wall-clock). When a
  // PAT-mode project is not ACTIVE_HEALTHY, skip those planes and record ONE
  // note instead. Platform-metadata planes (config/backups/advisors/pooler)
  // don't need a live DB and are still collected. In no-PAT mode (project is
  // null) the superuser --db-url points at a live DB, so dbServing stays true.
  const dbServing = !project || project.status === "ACTIVE_HEALTHY";
  if (!dbServing) {
    errors.push({
      source: "database",
      message: `project status is ${project?.status} (not ACTIVE_HEALTHY): the database and metrics endpoint are not serving, so SQL diagnostics and the metrics scrape were skipped. Platform metadata (config, backups, advisors) was still collected.`,
    });
    clog.warn("database not serving - skipping SQL + metrics planes", {
      status: project?.status,
    });
  }

  // Management planes that proxy the live database / running services also fail
  // on a paused project; gate them on dbServing too so an inactive project
  // emits no spurious per-plane warns. Static platform metadata planes (disk,
  // pgConfig, pooler, backups, advisors, ...) don't need a live DB and stay on
  // the plain `mgmt`.
  const mgmtLive = <T>(source: string, fn: (mm: Management) => Promise<T>, fallback: T) =>
    dbServing ? mgmt(source, fn, fallback) : Promise.resolve(fallback);

  const sql = (key: keyof typeof QUERIES) =>
    dbServing ? safe(`sql:${key}`, () => runner.run(QUERIES[key]), []) : Promise.resolve([]);

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
    tableIoStats,
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
    authAudit,
    authMfa,
    metricsText,
  ] = await Promise.all([
    mgmtLive("health", (mm) => mm.health(ref), []),
    mgmt("disk", (mm) => mm.disk(ref), null),
    mgmtLive("diskUtil", (mm) => mm.diskUtil(ref), null),
    mgmt("pgConfig", (mm) => mm.pgConfig(ref), null),
    mgmt("pooler", (mm) => mm.pooler(ref), null),
    mgmt("backups", (mm) => mm.backups(ref), null),
    mgmtLive("upgrade", (mm) => mm.upgrade(ref), null),
    mgmt("authConfig", (mm) => mm.authConfig(ref), null),
    mgmt("networkRestrictions", (mm) => mm.networkRestrictions(ref), null),
    mgmtLive("sslEnforcement", (mm) => mm.sslEnforcement(ref), null),
    mgmt("functions", (mm) => mm.functions(ref), []),
    mgmtLive("buckets", (mm) => mm.buckets(ref), []),
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
    sql("tableIoStats"),
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
    // pg_hba_file_rules requires a true superuser (supabase_admin); the PAT
    // read-only user is denied it (42501). Only attempt it on the superuser
    // SQL tier - otherwise it warns + records a note on every PAT run.
    runner.source === "superuser" ? sql("hbaRules") : Promise.resolve([]),
    sql("authAudit"),
    sql("authMfa"),
    transport && dbServing
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
  const rawDbBytes = dbSizeRows[0]?.db_size_bytes;
  const dbSizeBytes =
    rawDbBytes == null || !Number.isFinite(Number(rawDbBytes)) ? null : Number(rawDbBytes);

  // Exact reclaimable space via pgstattuple_approx - run ONLY when the extension
  // is already installed AND we have superuser SQL. sbperf never CREATEs it (a
  // write); the read-only PAT user can't exec it either. Cheap on well-vacuumed
  // tables (approx skips all-visible pages); safe() records a note and findings
  // fall back to the pg_stats estimate on any error/absence.
  const hasPgstattuple = extensions.some((r) => String(r.name) === "pgstattuple");
  const bloatExact =
    hasPgstattuple && runner.source === "superuser"
      ? await safe("sql:bloatExact", () => runner.run(QUERIES.bloatExact), [])
      : [];

  // Scheduled-job health reads cron.job / cron.job_run_details directly, which
  // ERROR if pg_cron isn't installed. Rather than fire-and-catch (a spurious
  // "relation cron.job does not exist" note on every DB without pg_cron), gate
  // on the extension inventory we already collected - the proper way to detect
  // an optional feature. Most DBs don't run pg_cron; absence is normal.
  const hasPgCron = extensions.some((r) => String(r.name) === "pg_cron");
  const cronJobs = hasPgCron
    ? await safe("sql:cronJobs", () => runner.run(QUERIES.cronJobs), [])
    : [];
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
      // Trends here can only have come from Prometheus/Grafana (the store/import
      // fill happens later, at report time). Only claim a source if it yielded data.
      trendSource: promUrl && trends.length ? "prometheus" : undefined,
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
      dbSizeBytes,
      cacheHitPct: Number.isFinite(cacheHitPct) ? cacheHitPct : null,
      indexHitPct: indexHitPct != null && Number.isFinite(indexHitPct) ? indexHitPct : null,
      cacheBlocksAccessed,
      statsResetAge,
      pgSettings,
      topStatements,
      topByCalls,
      queryIoStats,
      biggestTables,
      bloatExact,
      indexStats,
      duplicateIndexes,
      rlsUnindexed,
      seqScanHeavy,
      bloat,
      trafficProfile,
      tableIoStats,
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
      authAudit,
      authMfa,
      cronJobs,
    },
    metrics: { available: metricsText != null, samples },
    trends,
    sync: await syncP,
    narrative: null,
    errors,
  };

  // Tool-provenance signal (catalog vintage + vendored-splinter drift). Logged
  // here and persisted to analysis.json; deliberately NOT rendered in the
  // report - it describes sbperf's currency, not the audited database.
  if (analysis.sync)
    clog.info("sync check", {
      catalogReviewed: analysis.sync.catalogReviewed,
      stale: analysis.sync.stale,
      upstreamChecked: analysis.sync.upstreamChecked,
      advisorSqlDrifted: analysis.sync.advisorSqlDrifted,
    });

  clog.info("collect done", {
    collectionMs,
    errors: errors.length,
    metrics: analysis.metrics.available,
    trends: trends.length,
    samples: samples.length,
  });
  return analysis;
}
