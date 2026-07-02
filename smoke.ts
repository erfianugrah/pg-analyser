#!/usr/bin/env bun
/**
 * Live smoke test - exercises every data plane against a REAL project.
 * Not part of `bun test` (needs live credentials); run explicitly:
 *
 *   SUPABASE_ACCESS_TOKEN=sbp_... bun run smoke --ref <project-ref>
 *   SBPERF_SMOKE_REF=<ref> bun run smoke            # ref from env
 *
 * Exits non-zero if a hard invariant fails. Per-plane failures are reported
 * as WARN (a project may legitimately lack metrics, advisors, etc.).
 */
import { collect } from "./src/collect.ts";
import { ConfigError, loadConfig } from "./src/config.ts";
import type { Analysis } from "./src/schemas.ts";
import { makeTransport } from "./src/transport.ts";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

let hardFail = false;
function check(label: string, ok: boolean, detail = "", hard = false): void {
  const mark = ok ? `${GREEN}PASS${RESET}` : hard ? `${RED}FAIL${RESET}` : `${YELLOW}WARN${RESET}`;
  console.log(`  ${mark}  ${label}${detail ? ` ${DIM}${detail}${RESET}` : ""}`);
  if (!ok && hard) hardFail = true;
}

function refFromArgs(): string | undefined {
  const i = process.argv.indexOf("--ref");
  if (i !== -1) return process.argv[i + 1];
  return process.env.SBPERF_SMOKE_REF;
}

async function main(): Promise<void> {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`${RED}no credentials:${RESET} ${err.message}`);
      console.error("set SUPABASE_ACCESS_TOKEN");
      process.exit(2);
    }
    throw err;
  }

  const ref = refFromArgs();
  if (!ref) {
    console.error(`${RED}no project ref:${RESET} pass --ref <ref> or set SBPERF_SMOKE_REF`);
    process.exit(2);
  }

  console.log(`\nsbperf live smoke - project ${ref}\n`);

  const t = makeTransport(config);
  const started = Date.now();
  let a: Analysis;
  try {
    a = await collect(ref, t, "smoke");
  } catch (err) {
    check("collect() completed", false, err instanceof Error ? err.message : String(err), true);
    process.exit(1);
  }
  const ms = Date.now() - started;

  // hard invariants
  check("collect() completed", true, `${ms}ms`, true);
  check("project meta present", a.meta.name.length > 0, a.meta.name, true);

  // per-plane (soft)
  const errSources = new Set(a.errors.map((e) => e.source));
  check("service health", a.health.length > 0, `${a.health.length} services`);
  const unhealthy = a.health.filter((h) => !h.healthy).map((h) => h.name);
  if (unhealthy.length) check("all services healthy", false, `unhealthy: ${unhealthy.join(", ")}`);
  check("disk config", a.disk !== null, a.disk ? `${a.disk.sizeGb}GB ${a.disk.type}` : "");
  check(
    "advisors: performance",
    !errSources.has("advisors:performance"),
    `${a.advisors.performance.length} findings`,
  );
  check(
    "advisors: security",
    !errSources.has("advisors:security"),
    `${a.advisors.security.length} findings`,
  );
  check("read-only SQL (db size)", a.sql.dbSize !== null, a.sql.dbSize ?? "");
  check(
    "read-only SQL (cache hit)",
    a.sql.cacheHitPct !== null,
    a.sql.cacheHitPct != null ? `${a.sql.cacheHitPct}%` : "",
  );
  check(
    "read-only SQL (statements)",
    !errSources.has("sql:topStatements"),
    `${a.sql.topStatements.length} rows`,
  );
  check("metrics endpoint", a.metrics.available, `${a.metrics.samples.length} curated samples`);
  check("api-counts", !errSources.has("apiCounts"), `${a.apiCounts.length} buckets`);

  if (a.errors.length) {
    console.log(`\n${YELLOW}collection notes:${RESET}`);
    for (const e of a.errors) console.log(`  ${DIM}${e.source}:${RESET} ${e.message}`);
  }

  console.log(
    `\n${hardFail ? RED + "SMOKE FAILED" : GREEN + "SMOKE OK"}${RESET} - ` +
      `${a.advisors.performance.length + a.advisors.security.length} advisors, ` +
      `${a.metrics.samples.length} metrics, ${a.errors.length} notes\n`,
  );
  process.exit(hardFail ? 1 : 0);
}

await main();
