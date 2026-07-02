import { z } from "zod";

/**
 * Zod schemas for every external response we consume, plus the composed
 * `Analysis` object the report renders from. Unknown keys are stripped by
 * default (non-strict objects), so upstream additions won't break parsing -
 * but a shape change to a field we DO use fails loud at the boundary.
 */

// --- Management API responses ---

export const Project = z.object({
  id: z.string(),
  name: z.string(),
  region: z.string(),
  status: z.string(),
  created_at: z.string(),
  organization_id: z.string().optional(),
  database: z.object({ version: z.string() }).optional(),
});
export type Project = z.infer<typeof Project>;

export const ServiceHealth = z.object({
  name: z.string(),
  healthy: z.boolean(),
  status: z.string(),
});
export const HealthList = z.array(ServiceHealth);

export const DiskConfig = z.object({
  attributes: z.object({
    size_gb: z.number(),
    iops: z.number().optional(),
    type: z.string().optional(),
    throughput_mibps: z.number().optional(),
  }),
});

export const DiskUtil = z.object({
  timestamp: z.string().optional(),
  metrics: z.object({
    fs_size_bytes: z.number(),
    fs_avail_bytes: z.number(),
    fs_used_bytes: z.number(),
  }),
});

export const PoolerConfig = z.array(
  z.object({
    database_type: z.string().optional(),
    db_port: z.number().optional(),
    pool_mode: z.string().optional(),
    default_pool_size: z.number().nullable().optional(),
    max_client_conn: z.number().nullable().optional(),
  }),
);

export const PgConfig = z.record(z.string(), z.unknown());

export const Backups = z.object({
  pitr_enabled: z.boolean().optional(),
  walg_enabled: z.boolean().optional(),
  backups: z.array(z.unknown()).optional(),
});

export const EdgeFunction = z.object({
  id: z.string().optional(),
  slug: z.string(),
  name: z.string().optional(),
  status: z.string().optional(),
  version: z.number().optional(),
});
export const EdgeFunctions = z.array(EdgeFunction);

/** Raw functions.combined-stats response (per-time-bucket rows). */
export const FunctionStatsResponse = z.object({
  result: z.array(z.record(z.string(), z.unknown())).nullable().optional(),
  error: z.unknown().nullable().optional(),
});

/** Aggregated per-function invocation usage over the collected interval. */
export const FunctionUsage = z.object({
  slug: z.string(),
  requests: z.number(),
  success: z.number(),
  clientErr: z.number(),
  serverErr: z.number(),
  avgExecMs: z.number(),
  maxExecMs: z.number(),
});
export type FunctionUsage = z.infer<typeof FunctionUsage>;

export const StorageBucket = z.object({
  id: z.string().optional(),
  name: z.string(),
  public: z.boolean().optional(),
});
export const StorageBuckets = z.array(StorageBucket);

export const UpgradeEligibility = z.object({
  eligible: z.boolean(),
  current_app_version: z.string().optional(),
  latest_app_version: z.string().optional(),
});

export const Advisor = z.object({
  name: z.string(),
  title: z.string(),
  level: z.string(),
  facing: z.string().optional(),
  categories: z.array(z.string()).optional(),
  description: z.string().optional(),
  detail: z.string().optional(),
  remediation: z.string().nullable().optional(),
});
export type Advisor = z.infer<typeof Advisor>;
// The REST API wraps findings under `lints`; the CLI JSON uses `results`.
// Accept either, but fail loud if NEITHER is present (a shape change we must see).
export const AdvisorResponse = z
  .object({
    lints: z.array(Advisor).optional(),
    results: z.array(Advisor).optional(),
  })
  .refine((d) => d.lints !== undefined || d.results !== undefined, {
    message: "advisor response has neither `lints` nor `results`",
  })
  .transform((d) => (d.lints ?? d.results) as Advisor[]);

export const ApiCounts = z.object({
  result: z
    .array(
      z.object({
        timestamp: z.string(),
        total_auth_requests: z.number().optional(),
        total_realtime_requests: z.number().optional(),
        total_rest_requests: z.number().optional(),
        total_storage_requests: z.number().optional(),
      }),
    )
    .default([]),
});

/** read-only SQL runner returns a bare array of row objects. */
export const SqlRows = z.array(z.record(z.string(), z.unknown()));
export type SqlRow = Record<string, unknown>;

// --- composed Analysis (the report input) ---

export const MetricSample = z.object({
  name: z.string(),
  labels: z.record(z.string(), z.string()),
  value: z.number(),
});
export type MetricSample = z.infer<typeof MetricSample>;

export const TrendPoint = z.object({ t: z.number(), v: z.number() });
export const TrendSeries = z.object({
  title: z.string(),
  unit: z.string(),
  points: z.array(TrendPoint),
});
export type TrendSeries = z.infer<typeof TrendSeries>;

export const Analysis = z.object({
  meta: z.object({
    ref: z.string(),
    name: z.string(),
    region: z.string(),
    status: z.string(),
    pgVersion: z.string().nullable(),
    createdAt: z.string(),
    collectedAt: z.string(),
    sbperfVersion: z.string(),
  }),
  health: HealthList,
  disk: z
    .object({
      sizeGb: z.number().nullable(),
      iops: z.number().nullable(),
      type: z.string().nullable(),
      throughputMibps: z.number().nullable(),
      usedBytes: z.number().nullable(),
      availBytes: z.number().nullable(),
    })
    .nullable(),
  pgConfig: z.record(z.string(), z.unknown()).nullable(),
  pooler: PoolerConfig.nullable(),
  backups: Backups.nullable(),
  upgrade: UpgradeEligibility.nullable(),
  functions: EdgeFunctions,
  functionStats: z.array(FunctionUsage),
  buckets: StorageBuckets,
  advisors: z.object({
    performance: z.array(Advisor),
    security: z.array(Advisor),
  }),
  apiCounts: ApiCounts.shape.result,
  sql: z.object({
    dbSize: z.string().nullable(),
    cacheHitPct: z.number().nullable(),
    indexHitPct: z.number().nullable(),
    statsResetAge: z.string().nullable(),
    pgSettings: SqlRows,
    topStatements: SqlRows,
    topByCalls: SqlRows,
    biggestTables: SqlRows,
    indexStats: SqlRows,
    seqScanHeavy: SqlRows,
    bloat: SqlRows,
    trafficProfile: SqlRows,
    deadTuples: SqlRows,
    txidWraparound: SqlRows,
    replicationSlots: SqlRows,
    rlsPolicies: SqlRows,
    connections: SqlRows,
    roleStats: SqlRows,
    longRunning: SqlRows,
    locks: SqlRows,
    blocking: SqlRows,
    storageUsage: SqlRows,
  }),
  metrics: z.object({
    available: z.boolean(),
    samples: z.array(MetricSample),
  }),
  trends: z.array(TrendSeries),
  errors: z.array(z.object({ source: z.string(), message: z.string() })),
});
export type Analysis = z.infer<typeof Analysis>;
