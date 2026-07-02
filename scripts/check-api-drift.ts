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
 * The spec is public (no auth). Override with SBPERF_API_SPEC_URL if it moves.
 *
 * Scope: Management API (api.supabase.com) only. The per-project metrics
 * endpoint (<ref>.supabase.co/customer/v1/privileged/metrics) is a data-plane
 * route, not part of this spec - it is exercised by the live smoke instead.
 */

const SPEC_URL = process.env.SBPERF_API_SPEC_URL ?? "https://api.supabase.com/api/v1-json";

/** Single source of truth: (method, path) pairs sbperf calls in management.ts. */
const ENDPOINTS: ReadonlyArray<{ method: string; path: string; used: string }> = [
  { method: "get", path: "/v1/projects", used: "org-wide project iteration (--all)" },
  { method: "get", path: "/v1/projects/{ref}", used: "project meta (required)" },
  { method: "get", path: "/v1/projects/{ref}/health", used: "service health" },
  { method: "get", path: "/v1/projects/{ref}/config/disk", used: "disk spec" },
  { method: "get", path: "/v1/projects/{ref}/config/disk/util", used: "disk utilization" },
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

async function main(): Promise<void> {
  const res = await fetch(SPEC_URL, { headers: { accept: "application/json" } });
  if (!res.ok) {
    console.error(`error: could not fetch spec (${res.status}) from ${SPEC_URL}`);
    process.exit(2);
  }
  const spec = (await res.json()) as Spec;
  const paths = spec.paths ?? {};
  if (!Object.keys(paths).length) {
    console.error("error: spec has no paths - shape changed or wrong URL");
    process.exit(2);
  }

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
}

await main();
