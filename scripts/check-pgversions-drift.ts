#!/usr/bin/env bun
/**
 * Postgres latest-minor table drift-check (advisory). The vendored table in
 * src/pgversions.ts drives the no-PAT `pg_minor_behind` finding, so it must stay
 * current with upstream. This re-fetches the authoritative endoflife.date
 * dataset and diffs the latest-minor + EOL per major against PG_LATEST_MINOR.
 *
 *   bun run scripts/check-pgversions-drift.ts        # warn on drift, exit 0
 *   SBPERF_PGVER_STRICT=1 bun run ...                # exit 1 on drift (gated)
 *   SBPERF_PGVER_UPDATE=1 bun run ...                # print the refreshed table
 *
 * Advisory by design (needs network): a stale table just means the finding
 * under-reports how far behind a server is; it never fabricates. Mirrors
 * check:lints / check:inspect.
 */

import { PG_LATEST_MINOR } from "../src/pgversions.ts";

const IN_GHA = process.env.GITHUB_ACTIONS === "true";
const STRICT = process.env.SBPERF_PGVER_STRICT === "1";
const warn = (m: string): void => console.error(IN_GHA ? `::warning::${m}` : `warning: ${m}`);

type Cycle = { cycle: string; latest: string; eol: string | boolean };

let data: Cycle[];
try {
  const res = await fetch("https://endoflife.date/api/postgresql.json");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  data = (await res.json()) as Cycle[];
} catch (e) {
  warn(`could not fetch endoflife.date (${(e as Error).message}); skipping drift check`);
  process.exit(0);
}

const drift: string[] = [];
for (const major of Object.keys(PG_LATEST_MINOR)) {
  const up = data.find((c) => c.cycle === major);
  if (!up) {
    drift.push(`major ${major} no longer in upstream dataset`);
    continue;
  }
  const have = PG_LATEST_MINOR[major]!;
  if (up.latest !== have.latest) drift.push(`${major}: latest ${have.latest} -> ${up.latest}`);
  if (typeof up.eol === "string" && up.eol !== have.eol)
    drift.push(`${major}: eol ${have.eol} -> ${up.eol}`);
}

if (process.env.SBPERF_PGVER_UPDATE === "1") {
  const rows = data
    .filter((c) => Number(c.cycle) >= 12)
    .map((c) => `  "${c.cycle}": { latest: "${c.latest}", eol: "${c.eol}" },`)
    .join("\n");
  console.log(
    `export const PG_LATEST_MINOR: Record<string, { latest: string; eol: string }> = {\n${rows}\n};`,
  );
  process.exit(0);
}

if (drift.length === 0) {
  console.log(
    `pg version table in sync with endoflife.date (${Object.keys(PG_LATEST_MINOR).length} majors)`,
  );
  process.exit(0);
}
for (const d of drift) warn(`pgversions drift - ${d}`);
warn(
  "refresh src/pgversions.ts (SBPERF_PGVER_UPDATE=1 bun run scripts/check-pgversions-drift.ts) and bump PG_VERSIONS_AS_OF",
);
process.exit(STRICT ? 1 : 0);
