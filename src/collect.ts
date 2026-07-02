import { Management } from "./management.ts";
import { curate, parsePrometheus } from "./metrics.ts";
import { fetchTrends } from "./prometheus.ts";
import { type Analysis, MetricSample } from "./schemas.ts";
import { QUERIES } from "./sql.ts";
import type { Transport } from "./transport.ts";

type CollectError = { source: string; message: string };

/** Collect every plane for a project into one validated Analysis object. */
export async function collect(
  ref: string,
  transport: Transport,
  version: string,
  opts: { prometheusUrl?: string } = {},
): Promise<Analysis> {
  const m = new Management(transport);
  const errors: CollectError[] = [];

  const safe = async <T>(source: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      errors.push({ source, message: err instanceof Error ? err.message : String(err) });
      return fallback;
    }
  };

  // project meta is required - everything else is best-effort.
  const project = await m.project(ref).catch((err) => {
    throw new Error(`cannot read project ${ref}: ${err instanceof Error ? err.message : err}`);
  });

  const sql = (key: keyof typeof QUERIES) =>
    safe(`sql:${key}`, () => m.readOnlySql(ref, QUERIES[key]), []);

  const [
    health,
    disk,
    diskUtil,
    pgConfig,
    pooler,
    backups,
    upgrade,
    functions,
    buckets,
    perfAdvisors,
    secAdvisors,
    apiCounts,
    dbSizeRows,
    cacheHitRows,
    pgSettings,
    topStatements,
    topByCalls,
    biggestTables,
    unusedIndexes,
    seqScanHeavy,
    deadTuples,
    txidWraparound,
    replicationSlots,
    rlsPolicies,
    connections,
    storageUsage,
    metricsText,
  ] = await Promise.all([
    safe("health", () => m.health(ref), []),
    safe("disk", () => m.disk(ref), null),
    safe("diskUtil", () => m.diskUtil(ref), null),
    safe("pgConfig", () => m.pgConfig(ref), null),
    safe("pooler", () => m.pooler(ref), null),
    safe("backups", () => m.backups(ref), null),
    safe("upgrade", () => m.upgrade(ref), null),
    safe("functions", () => m.functions(ref), []),
    safe("buckets", () => m.buckets(ref), []),
    safe("advisors:performance", () => m.advisors(ref, "performance"), []),
    safe("advisors:security", () => m.advisors(ref, "security"), []),
    safe("apiCounts", () => m.apiCounts(ref), []),
    sql("dbSize"),
    sql("cacheHit"),
    sql("pgSettings"),
    sql("topStatements"),
    sql("topByCalls"),
    sql("biggestTables"),
    sql("unusedIndexes"),
    sql("seqScanHeavy"),
    sql("deadTuples"),
    sql("txidWraparound"),
    sql("replicationSlots"),
    sql("rlsPolicies"),
    sql("connections"),
    sql("storageUsage"),
    safe(
      "metrics",
      async () => {
        const res = await transport.metrics(ref);
        if (!res.ok) throw new Error(`metrics -> ${res.status}`);
        return await res.text();
      },
      null,
    ),
  ]);

  const samples = metricsText
    ? curate(parsePrometheus(metricsText)).map((s) => MetricSample.parse(s))
    : [];
  const trends = opts.prometheusUrl
    ? await safe("trends", () => fetchTrends(opts.prometheusUrl as string), [])
    : [];

  // Per-function invocation stats depend on the functions list (need each id),
  // so they run after the parallel batch. Best-effort per function.
  const functionStats: Analysis["functionStats"] = [];
  for (const fn of functions) {
    if (!fn.id) continue;
    const id = fn.id;
    const resp = await safe(`functionStats:${fn.slug}`, () => m.functionStats(ref, id), null);
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

  const dbSize = (dbSizeRows[0]?.db_size as string | undefined) ?? null;
  const rawCacheHit = cacheHitRows[0]?.cache_hit_pct;
  const cacheHitPct = rawCacheHit == null ? null : Number(rawCacheHit);

  const analysis: Analysis = {
    meta: {
      ref,
      name: project.name,
      region: project.region,
      status: project.status,
      pgVersion: project.database?.version ?? null,
      createdAt: project.created_at,
      collectedAt: new Date().toISOString(),
      sbperfVersion: version,
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
    pgConfig,
    pooler,
    backups,
    upgrade,
    functions,
    functionStats,
    buckets,
    advisors: { performance: perfAdvisors, security: secAdvisors },
    apiCounts,
    sql: {
      dbSize,
      cacheHitPct: Number.isFinite(cacheHitPct) ? cacheHitPct : null,
      pgSettings,
      topStatements,
      topByCalls,
      biggestTables,
      unusedIndexes,
      seqScanHeavy,
      deadTuples,
      txidWraparound,
      replicationSlots,
      rlsPolicies,
      connections,
      storageUsage,
    },
    metrics: { available: metricsText != null, samples },
    trends,
    errors,
  };

  return analysis;
}
