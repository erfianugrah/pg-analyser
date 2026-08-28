/**
 * Acceptance-suite fixture builder.
 *
 * This directory is the CONTRACT for the wraparound-forensics plan
 * (docs/plans/2026-08-07-wraparound-forensics.md) and sits OUTSIDE the
 * self-correcting loop's write scope: the implementation must satisfy it, not
 * edit it.
 *
 * The base analysis is a plain object parsed THROUGH the zod schema on every
 * build, which is deliberate:
 *   - a new plane field added without a `.default(...)` makes every acceptance
 *     test fail loudly (the repo convention is back-compat defaults);
 *   - a plane field a test sets but the schema does not declare is STRIPPED by
 *     zod, so "the finding fires" cannot pass before the schema is wired.
 */
import { Analysis } from "../src/schemas.ts";

type Raw = Record<string, unknown> & { sql: Record<string, unknown> };

const BASE: Raw = {
  meta: {
    ref: "examplerefaaaaaaaaaa",
    name: "acceptance",
    region: "eu-central-1",
    status: "ACTIVE_HEALTHY",
    pgVersion: "17",
    createdAt: "2026-01-01T00:00:00Z",
    collectedAt: "2026-08-07T00:00:00Z",
    sbperfVersion: "0.0.0-acceptance",
    sqlSource: "superuser",
    logProbe: null,
  },
  health: [],
  disk: null,
  pgConfig: null,
  pooler: null,
  backups: null,
  upgrade: null,
  functions: [],
  functionStats: [],
  buckets: [],
  security: null,
  advisors: { performance: [], security: [] },
  apiCounts: [],
  sql: {
    dbSize: null,
    cacheHitPct: null,
    indexHitPct: null,
    cacheBlocksAccessed: null,
    statementsDealloc: null,
    tableStatsResetAge: null,
    statsResetAge: null,
    pgSettings: [],
    topStatements: [],
    topByCalls: [],
    queryIoStats: [],
    biggestTables: [],
    indexStats: [],
    duplicateIndexes: [],
    rlsUnindexed: [],
    seqScanHeavy: [],
    bloat: [],
    trafficProfile: [],
    tableIoStats: [],
    deadTuples: [],
    txidWraparound: [],
    multixactWraparound: [],
    neverVacuumed: [],
    fkUnindexed: [],
    invalidIndexes: [],
    managedNoPk: [],
    topByWal: [],
    visibilityMap: [],
    hotUpdates: [],
    publicSchemaCreate: [],
    replicationSlots: [],
    rlsPolicies: [],
    rlsPolicyDeps: [],
    connections: [],
    roleStats: [],
    roleConfig: [],
    longRunning: [],
    locks: [],
    blocking: [],
    storageUsage: [],
    extensions: [],
    unindexedVectors: [],
    sequenceExhaustion: [],
    walArchiving: [],
    hbaRules: [],
    authAudit: [],
    authMfa: [],
    cronJobs: [],
    waitSamples: [],
    lockWave: null,
    dbSizeBytes: null,
    bloatExact: [],
    indexAdvisor: [],
    unloggedTables: [],
    checksumFailures: [],
    walDirSize: [],
    amcheckIndex: [],
    amcheckHeap: [],
  },
  metrics: { available: false, samples: [] },
  trends: [],
  contentionEpisodes: [],
  sync: null,
  narrative: null,
  errors: [],
};

/** Build an Analysis from the base fixture, mutated by `mut`, parsed by zod. */
export function analysis(mut?: (raw: Raw) => void) {
  const raw = structuredClone(BASE);
  mut?.(raw);
  return Analysis.parse(raw);
}

/** 2^31 - 1000000: the "remaining transactions" denominator the plan fixes. */
export const CEILING = 2 ** 31 - 1_000_000;
