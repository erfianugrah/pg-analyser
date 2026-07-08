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

export const Organization = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string().optional(),
});
export type Organization = z.infer<typeof Organization>;

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
  // When the volume was last resized (grow-only autoscale or a manual change).
  last_modified_at: z.string().optional(),
});

// GET /v1/projects/{ref}/config/disk/autoscale. Autoscale is GROW-ONLY: the
// volume expands by growth_percent in min_increment_gb steps up to max_size_gb
// and never shrinks, so reclaiming over-provisioned space always needs an
// explicit resize. All three fields are explicitly nullable in the spec.
export const DiskAutoscaleConfig = z.object({
  growth_percent: z.number().nullable(),
  min_increment_gb: z.number().nullable(),
  max_size_gb: z.number().nullable(),
});
export type DiskAutoscaleConfig = z.infer<typeof DiskAutoscaleConfig>;

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

// --- Security config planes (Management API) ---
// GoTrue auth config. Only the security-relevant fields are declared; unknown
// keys are stripped (non-strict), so the ~90-field response parses cleanly and
// upstream additions never break us. Field names verified against the live
// OpenAPI spec (AuthConfigResponse) - a wrong name would silently no-op a check.
export const AuthConfig = z.object({
  disable_signup: z.boolean().optional(),
  external_anonymous_users_enabled: z.boolean().optional(),
  jwt_exp: z.number().optional(),
  mailer_autoconfirm: z.boolean().optional(),
  mfa_totp_enroll_enabled: z.boolean().optional(),
  mfa_totp_verify_enabled: z.boolean().optional(),
  mfa_phone_verify_enabled: z.boolean().optional(),
  mfa_web_authn_verify_enabled: z.boolean().optional(),
  password_hibp_enabled: z.boolean().optional(),
  password_min_length: z.number().optional(),
  // The API returns explicit null (not absent) when no character-class
  // requirement is set, so this must be nullable, not merely optional -
  // otherwise the whole authConfig plane is dropped on such a project.
  password_required_characters: z.string().nullable().optional(),
  security_captcha_enabled: z.boolean().optional(),
  refresh_token_rotation_enabled: z.boolean().optional(),
  security_update_password_require_reauthentication: z.boolean().optional(),
});
export type AuthConfig = z.infer<typeof AuthConfig>;

// GET /v1/projects/{ref}/network-restrictions. An empty/absent dbAllowedCidrs
// (or the wide-open 0.0.0.0/0) means the database is reachable from any IP.
export const NetworkRestrictions = z.object({
  entitlement: z.string().optional(),
  config: z
    .object({
      dbAllowedCidrs: z.array(z.string()).optional(),
      dbAllowedCidrsV6: z.array(z.string()).optional(),
    })
    .optional(),
  status: z.string().optional(),
});
export type NetworkRestrictions = z.infer<typeof NetworkRestrictions>;

// GET /v1/projects/{ref}/ssl-enforcement. currentConfig.database=false means
// unencrypted DB connections are accepted.
export const SslEnforcement = z.object({
  currentConfig: z.object({ database: z.boolean() }),
  appliedSuccessfully: z.boolean().optional(),
});
export type SslEnforcement = z.infer<typeof SslEnforcement>;

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

/** On-by-default upstream sync check result (see sync.ts). */
export const SyncStatus = z.object({
  catalogReviewed: z.string(),
  ageDays: z.number(),
  stale: z.boolean(),
  upstreamChecked: z.boolean(),
  advisorSqlDrifted: z.boolean().nullable(),
  note: z.string(),
});
export type SyncStatus = z.infer<typeof SyncStatus>;

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
    // Which SQL tier produced the diagnostics. Defaulted for back-compat with
    // analysis.json written before the superuser tier existed.
    sqlSource: z.enum(["read-only", "superuser"]).default("read-only"),
    // False in no-PAT mode: no Supabase Management API was available, so
    // advisors came from self-hosted splinter, SQL from a superuser --db-url,
    // trends from Grafana; provisioning/backups/metrics/analytics were skipped.
    // Optional/absent == PAT mode (back-compat + consumers test `=== false`).
    managementApi: z.boolean().optional(),
    // Wall-clock collection time (ms). Optional metadata for the report footer +
    // operational logging; absent in analysis.json written before it existed.
    collectionMs: z.number().optional(),
    // Where the trend series came from, so the report can label the Resource
    // snapshot (and note that CloudWatch-only panels like EBS burst-balance are
    // absent from the non-CloudWatch sources). "prometheus" = a Prometheus/
    // Grafana TSDB, "store" = the sbperf SQLite history store, "import" = an
    // imported CSV/JSON series. Absent = no trends (single run).
    trendSource: z.enum(["prometheus", "store", "import"]).optional(),
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
      // When the volume was last resized. Optional/defaulted for back-compat.
      lastModifiedAt: z.string().nullable().default(null),
      // Grow-only autoscale policy (null when not configured / not fetched).
      autoscale: z
        .object({
          growthPercent: z.number().nullable(),
          minIncrementGb: z.number().nullable(),
          maxSizeGb: z.number().nullable(),
        })
        .nullable()
        .default(null),
    })
    .nullable(),
  pgConfig: z.record(z.string(), z.unknown()).nullable(),
  pooler: PoolerConfig.nullable(),
  backups: Backups.nullable(),
  upgrade: UpgradeEligibility.nullable(),
  functions: EdgeFunctions,
  functionStats: z.array(FunctionUsage),
  buckets: StorageBuckets,
  // Security config planes (auth / network / SSL). Null in no-PAT mode (no
  // Management API); nullable + defaulted for back-compat with analysis.json
  // written before this plane existed. Each sub-plane is independently nullable
  // (a single endpoint can 403 on a restricted PAT without nulling the rest).
  security: z
    .object({
      auth: AuthConfig.nullable(),
      networkRestrictions: NetworkRestrictions.nullable(),
      sslEnforcement: SslEnforcement.nullable(),
    })
    .nullable()
    .default(null),
  advisors: z.object({
    performance: z.array(Advisor),
    security: z.array(Advisor),
  }),
  apiCounts: ApiCounts.shape.result,
  sql: z.object({
    dbSize: z.string().nullable(),
    // Database size in bytes - lets findings attribute disk usage to the
    // largest tables as a fraction of the whole. Defaulted for back-compat.
    dbSizeBytes: z.number().nullable().default(null),
    cacheHitPct: z.number().nullable(),
    indexHitPct: z.number().nullable(),
    // Total heap blocks accessed since stats reset - the activity floor that
    // gates the cache-hit finding/positive. Defaulted for back-compat.
    cacheBlocksAccessed: z.number().nullable().default(null),
    statsResetAge: z.string().nullable(),
    pgSettings: SqlRows,
    topStatements: SqlRows,
    topByCalls: SqlRows,
    // Per-query I/O + latency-stability depth. Defaulted for back-compat.
    queryIoStats: SqlRows.default([]),
    biggestTables: SqlRows,
    // Measured (pgstattuple_approx) reclaimable space on the biggest tables -
    // populated ONLY when the extension is installed + superuser SQL. Empty
    // otherwise (findings fall back to the pg_stats estimate). Back-compat default.
    bloatExact: SqlRows.default([]),
    indexStats: SqlRows,
    duplicateIndexes: SqlRows,
    rlsUnindexed: SqlRows,
    seqScanHeavy: SqlRows,
    bloat: SqlRows,
    trafficProfile: SqlRows,
    // Per-table I/O breakdown (pg_statio_user_tables): heap/idx/TOAST blocks
    // read vs cached + hit ratios. Powers per-relation IO attribution and the
    // TOAST cache-cold finding. Internal composed field; defaulted for
    // back-compat with analysis.json written before the query existed.
    tableIoStats: SqlRows.default([]),
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
    // Extension inventory + pgvector index health. Defaulted for back-compat
    // with analysis.json written before these queries existed (an internal
    // composed field, not an external API response - the no-.default rule is
    // about masking upstream API shape drift, which does not apply here).
    extensions: SqlRows.default([]),
    unindexedVectors: SqlRows.default([]),
    // WAL-archiving state (pg_stat_archiver + archive_mode) - the SQL proxy for
    // PITR when the Management API backups plane is absent. Defaulted for
    // back-compat with analysis.json written before the query existed.
    walArchiving: SqlRows.default([]),
    // Cluster-wide page-checksum failure counters (pg_stat_database). Both
    // modes; nonzero = on-disk corruption. Defaulted for back-compat.
    checksumFailures: SqlRows.default([]),
    // pg_wal directory size (superuser only). Feeds disk-footprint math.
    // Empty when not superuser / not granted pg_monitor. Back-compat default.
    walDirSize: SqlRows.default([]),
    // amcheck integrity results (opt-in, superuser + extension gated). One row
    // per corruption hit; empty means "not run" OR "ran clean". Back-compat.
    amcheckIndex: SqlRows.default([]),
    amcheckHeap: SqlRows.default([]),
    // Host-based auth rules (pg_hba_file_rules) - the SQL proxy for SSL
    // enforcement when the Management API ssl-enforcement plane is absent.
    hbaRules: SqlRows.default([]),
    // Auth adoption (auth schema) + scheduled-job health (pg_cron). SQL-derived
    // so both modes get them; defaulted for back-compat.
    authAudit: SqlRows.default([]),
    authMfa: SqlRows.default([]),
    cronJobs: SqlRows.default([]),
  }),
  metrics: z.object({
    available: z.boolean(),
    samples: z.array(MetricSample),
  }),
  trends: z.array(TrendSeries),
  // Upstream sync check; nullable + defaulted for back-compat with analysis.json
  // written before the check existed.
  sync: SyncStatus.nullable().default(null),
  // LLM narrative (Markdown) from `narrate`; embedded in report.html on demand.
  narrative: z.string().nullable().default(null),
  errors: z.array(z.object({ source: z.string(), message: z.string() })),
});
export type Analysis = z.infer<typeof Analysis>;
