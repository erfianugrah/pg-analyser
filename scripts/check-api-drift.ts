#!/usr/bin/env bun
/**
 * Upstream drift-check. Instead of tracking the Supabase Management API by hand
 * (or leaning on the CLI as a source of truth), assert that every endpoint
 * sbperf depends on still exists - with the HTTP method we use - in the
 * canonical OpenAPI spec. CI runs this so an upstream rename/removal fails the
 * build loudly rather than surfacing as a runtime 404 in front of a user.
 *
 *   bun run scripts/check-api-drift.ts
 *
 * Two layers:
 *   1. PRIMARY (pass/fail): assert sbperf's endpoints exist in the LIVE spec
 *      (api.supabase.com/api/v1-json) - the ground truth for what the deployed
 *      API actually accepts. Missing endpoint => exit 1.
 *   2. CROSS-CHECK (advisory): diff the live spec against the version-controlled
 *      copy in supabase/supabase (apps/docs/spec). The docs copy is generated
 *      FROM the API and can lag a deploy; a divergence is an early signal that
 *      upstream is mid-change. Never fails the build on its own - emits a
 *      warning (a GitHub Actions ::warning:: annotation in CI).
 *
 * Specs are public (no auth). Overrides: SBPERF_API_SPEC_URL (live),
 * SBPERF_API_SPEC_COMPARE_URL (docs copy), SBPERF_NO_CROSSCHECK=1 to skip (2).
 *
 * Scope: Management API (api.supabase.com) only. The per-project metrics
 * endpoint (<ref>.supabase.co/customer/v1/privileged/metrics) is a data-plane
 * route, not part of this spec - it is exercised by the live smoke instead.
 */

const SPEC_URL = process.env.SBPERF_API_SPEC_URL ?? "https://api.supabase.com/api/v1-json";
const COMPARE_URL =
  process.env.SBPERF_API_SPEC_COMPARE_URL ??
  "https://raw.githubusercontent.com/supabase/supabase/master/apps/docs/spec/api_v1_openapi.json";
const CROSS_CHECK = process.env.SBPERF_NO_CROSSCHECK !== "1";
const IN_GHA = process.env.GITHUB_ACTIONS === "true";
const warn = (msg: string): void => console.error(IN_GHA ? `::warning::${msg}` : `warning: ${msg}`);

/** Single source of truth: (method, path) pairs sbperf calls in management.ts. */
const ENDPOINTS: ReadonlyArray<{ method: string; path: string; used: string }> = [
  { method: "get", path: "/v1/projects", used: "org-wide project iteration (--all)" },
  { method: "get", path: "/v1/organizations", used: "org grouping for --all output" },
  { method: "get", path: "/v1/projects/{ref}", used: "project meta (required)" },
  { method: "get", path: "/v1/projects/{ref}/health", used: "service health" },
  { method: "get", path: "/v1/projects/{ref}/config/disk", used: "disk spec" },
  { method: "get", path: "/v1/projects/{ref}/config/disk/util", used: "disk utilization" },
  {
    method: "get",
    path: "/v1/projects/{ref}/config/disk/autoscale",
    used: "grow-only autoscale policy",
  },
  { method: "get", path: "/v1/projects/{ref}/config/database/postgres", used: "pg config" },
  { method: "get", path: "/v1/projects/{ref}/config/database/pooler", used: "pooler config" },
  { method: "get", path: "/v1/projects/{ref}/database/backups", used: "backups" },
  {
    method: "post",
    path: "/v1/projects/{ref}/database/query/read-only",
    used: "read-only SQL runner",
  },
  { method: "get", path: "/v1/projects/{ref}/functions", used: "edge function inventory" },
  { method: "get", path: "/v1/projects/{ref}/storage/buckets", used: "storage buckets" },
  { method: "get", path: "/v1/projects/{ref}/upgrade/eligibility", used: "pg upgrade drift" },
  { method: "get", path: "/v1/projects/{ref}/config/auth", used: "auth security config plane" },
  {
    method: "get",
    path: "/v1/projects/{ref}/network-restrictions",
    used: "DB network restriction (IP allowlist) security finding",
  },
  {
    method: "get",
    path: "/v1/projects/{ref}/ssl-enforcement",
    used: "SSL enforcement security finding",
  },
  { method: "get", path: "/v1/projects/{ref}/advisors/performance", used: "performance advisors" },
  { method: "get", path: "/v1/projects/{ref}/advisors/security", used: "security advisors" },
  {
    method: "get",
    path: "/v1/projects/{ref}/analytics/endpoints/usage.api-counts",
    used: "API request volume",
  },
  {
    method: "get",
    path: "/v1/projects/{ref}/analytics/endpoints/functions.combined-stats",
    used: "per-function invocation stats",
  },
  { method: "get", path: "/v1/projects/{ref}/api-keys", used: "service_role for metrics" },
];

type Spec = { info?: { version?: string }; paths?: Record<string, Record<string, unknown>> };

async function fetchSpec(url: string): Promise<Spec | null> {
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const spec = (await res.json()) as Spec;
    return spec.paths && Object.keys(spec.paths).length ? spec : null;
  } catch {
    return null;
  }
}

/** Advisory: warn (never fail) when the docs-site spec has drifted from live. */
async function crossCheck(livePaths: Record<string, unknown>): Promise<void> {
  const other = await fetchSpec(COMPARE_URL);
  if (!other?.paths) {
    warn(`cross-check skipped - could not fetch docs spec from ${COMPARE_URL}`);
    return;
  }
  const live = new Set(Object.keys(livePaths));
  const docs = new Set(Object.keys(other.paths));
  const onlyLive = [...live].filter((p) => !docs.has(p));
  const onlyDocs = [...docs].filter((p) => !live.has(p));

  // Endpoints sbperf actually uses that disagree between the two = strongest signal.
  const affected = ENDPOINTS.filter((e) => live.has(e.path) !== docs.has(e.path)).map(
    (e) => e.path,
  );
  if (affected.length) {
    warn(
      `endpoints sbperf uses differ between live and docs spec (upstream mid-change?): ${affected.join(", ")}`,
    );
  }

  if (onlyLive.length || onlyDocs.length) {
    const parts: string[] = [];
    if (onlyLive.length) parts.push(`${onlyLive.length} live-only`);
    if (onlyDocs.length) parts.push(`${onlyDocs.length} docs-only`);
    warn(`live and docs specs diverge (${parts.join(", ")}) - docs copy may be lagging a deploy`);
  } else {
    console.log(`cross-check: live and docs spec agree (${live.size} paths)`);
  }
}

async function main(): Promise<void> {
  const spec = await fetchSpec(SPEC_URL);
  if (!spec?.paths) {
    console.error(`error: could not fetch a valid spec from ${SPEC_URL}`);
    process.exit(2);
  }
  const paths = spec.paths;

  const missing: string[] = [];
  for (const e of ENDPOINTS) {
    const methods = paths[e.path];
    if (!methods) {
      missing.push(`${e.method.toUpperCase()} ${e.path} - PATH GONE (${e.used})`);
    } else if (!(e.method in methods)) {
      const have = Object.keys(methods).join(",").toUpperCase();
      missing.push(
        `${e.method.toUpperCase()} ${e.path} - METHOD GONE (spec has ${have}) (${e.used})`,
      );
    }
  }

  const v = spec.info?.version ?? "?";
  if (missing.length) {
    console.error(`\nAPI drift detected against Supabase Management API spec v${v}:\n`);
    for (const m of missing) console.error(`  x ${m}`);
    console.error(
      `\n${missing.length}/${ENDPOINTS.length} endpoint(s) drifted. Update management.ts + this manifest.\n`,
    );
    process.exit(1);
  }
  console.log(`ok: all ${ENDPOINTS.length} endpoints present in Management API spec v${v}`);

  if (CROSS_CHECK) await crossCheck(paths);
}

await main();
