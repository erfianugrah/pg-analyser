#!/usr/bin/env bun
/**
 * Inspect-SQL drift-check (advisory). sbperf DERIVES its diagnostic queries
 * (src/sql.ts) from the Supabase CLI's `inspect` SQL, but does NOT vendor them
 * verbatim - the CLI queries use bind parameters (`LIKE ANY($1)`) that can't
 * pass through the PAT read-only endpoint, and sbperf's findings consume raw
 * columns (e.g. bloat `waste_bytes`) that the CLI SQL wraps away in
 * pg_size_pretty(). So a byte-diff would be meaningless. Instead this check
 * records a fingerprint of each UPSTREAM query at the time we last reviewed our
 * derived version, and WARNS when upstream changes - a nudge to re-review our
 * copy, not a runtime dependency. This structurally guards against the
 * silent-drift class of bug (e.g. the RLS unwrapped-auth false positive).
 *
 *   bun run scripts/check-inspect-drift.ts            # check, warn on drift
 *   SBPERF_INSPECT_UPDATE=1 bun run scripts/check-inspect-drift.ts   # accept
 *                                                       upstream after review
 *
 * Advisory by design: exit 0 even on drift (emits ::warning:: in CI). Upstream
 * changing their SQL does not break sbperf at runtime - our queries are
 * independent - so a red build would be noise. The warning is the signal.
 * Set SBPERF_INSPECT_STRICT=1 to exit 1 on drift instead (e.g. a gated job).
 *
 * Override the branch with SBPERF_CLI_REF (default: develop).
 */

import { createHash } from "node:crypto";

const CLI_REF = process.env.SBPERF_CLI_REF ?? "develop";
const RAW_BASE = `https://raw.githubusercontent.com/supabase/cli/${CLI_REF}/apps/cli-go/internal/inspect`;
const UPDATE = process.env.SBPERF_INSPECT_UPDATE === "1";
const STRICT = process.env.SBPERF_INSPECT_STRICT === "1";
const IN_GHA = process.env.GITHUB_ACTIONS === "true";
const warn = (msg: string): void => console.error(IN_GHA ? `::warning::${msg}` : `warning: ${msg}`);

const BASELINE_PATH = new URL("./inspect-baseline.json", import.meta.url).pathname;

/**
 * Manifest: each sbperf query in src/sql.ts that is DERIVED from a CLI inspect
 * query, mapped to its upstream source dir. `derives` is the QUERIES key in
 * src/sql.ts - the thing to re-review when the upstream fingerprint drifts.
 * Add a row here when you port (or adapt) a new inspect query.
 */
const MANIFEST: ReadonlyArray<{ dir: string; derives: string; note?: string }> = [
  {
    dir: "bloat",
    derives: "bloat",
    note: "CLI covers indexes too; ours is tables-only + waste_bytes",
  },
  { dir: "index_stats", derives: "indexStats" },
  {
    dir: "unused_indexes",
    derives: "seqScanHeavy",
    note: "seq-scan-heavy is our angle on the same signal",
  },
  { dir: "table_stats", derives: "biggestTables" },
  {
    dir: "vacuum_stats",
    derives: "deadTuples",
    note: "ours is threshold-aware (per-table trigger), an improvement",
  },
  { dir: "traffic_profile", derives: "trafficProfile" },
  { dir: "outliers", derives: "topStatements" },
  { dir: "calls", derives: "topByCalls" },
  { dir: "role_stats", derives: "roleStats" },
  { dir: "db_stats", derives: "cacheHit", note: "cache-hit + index-hit ratio" },
  { dir: "long_running_queries", derives: "longRunning" },
  { dir: "locks", derives: "locks" },
  { dir: "blocking", derives: "blocking" },
  { dir: "replication_slots", derives: "replicationSlots" },
];

export type Baseline = Record<string, { sha256: string; reviewed: string }>;

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/**
 * Pure drift classification (unit-tested). Given the manifest, the recorded
 * baseline hashes, and freshly-fetched upstream hashes, partition each query
 * into drifted (hash changed) / missing (no baseline yet). Queries we couldn't
 * refetch (absent from `current`) are neither - they're reported separately.
 */
export function classifyDrift(
  manifest: ReadonlyArray<{ dir: string; derives: string; note?: string }>,
  baseline: Baseline,
  current: Map<string, string>,
): { drifted: string[]; missing: string[] } {
  const drifted: string[] = [];
  const missing: string[] = [];
  for (const m of manifest) {
    const now = current.get(m.dir);
    const base = baseline[m.dir];
    if (!base) {
      missing.push(`${m.dir} (no baseline - run with SBPERF_INSPECT_UPDATE=1)`);
      continue;
    }
    if (now && now !== base.sha256) {
      drifted.push(
        `${m.dir}.sql changed upstream -> re-review src/sql.ts:${m.derives}` +
          (m.note ? ` (${m.note})` : "") +
          ` [baseline reviewed ${base.reviewed}]`,
      );
    }
  }
  return { drifted, missing };
}

async function fetchSql(dir: string): Promise<string | null> {
  try {
    const res = await fetch(`${RAW_BASE}/${dir}/${dir}.sql`, { headers: { accept: "text/plain" } });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

async function loadBaseline(): Promise<Baseline> {
  try {
    return JSON.parse(await Bun.file(BASELINE_PATH).text()) as Baseline;
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  const baseline = await loadBaseline();
  const today = new Date().toISOString().slice(0, 10);

  const current = new Map<string, string>();
  const unreachable: string[] = [];
  await Promise.all(
    MANIFEST.map(async (m) => {
      const sql = await fetchSql(m.dir);
      if (sql === null) unreachable.push(m.dir);
      else current.set(m.dir, sha256(sql));
    }),
  );

  if (UPDATE) {
    const next: Baseline = {};
    for (const m of MANIFEST) {
      const h = current.get(m.dir);
      // Preserve an old hash+date for anything we couldn't refetch this run.
      if (h) next[m.dir] = { sha256: h, reviewed: today };
      else if (baseline[m.dir]) next[m.dir] = baseline[m.dir] as Baseline[string];
    }
    await Bun.write(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`baseline updated (${Object.keys(next).length} queries, reviewed ${today})`);
    if (unreachable.length) warn(`could not refetch: ${unreachable.join(", ")} (kept old hash)`);
    return;
  }

  const { drifted, missing } = classifyDrift(MANIFEST, baseline, current);

  if (unreachable.length) warn(`could not fetch upstream: ${unreachable.join(", ")}`);
  for (const msg of missing) warn(msg);

  if (drifted.length) {
    warn(
      `${drifted.length}/${MANIFEST.length} upstream inspect queries drifted since last review:`,
    );
    for (const d of drifted) warn(`  ${d}`);
    warn(
      "review whether our derived query needs the same change, then accept with " +
        "SBPERF_INSPECT_UPDATE=1 bun run scripts/check-inspect-drift.ts",
    );
    if (STRICT) process.exit(1);
    return;
  }

  const covered = MANIFEST.filter((m) => baseline[m.dir]).length;
  console.log(
    `ok: ${covered}/${MANIFEST.length} derived inspect queries match their upstream baseline (cli@${CLI_REF})`,
  );
}

if (import.meta.main) await main();
