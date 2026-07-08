#!/usr/bin/env bun
/**
 * Application-schema denylist drift-check (advisory). `NON_APP_SCHEMAS` in
 * src/appschema.ts decides which schemas sbperf treats as the user's own tables
 * (vs Postgres-internal / Supabase-managed). It must stay aligned with the
 * exclusion set baked into splinter.sql's `unused_index` lint, so sbperf's
 * SQL-derived index/RLS findings and the narrate digest scope to the SAME
 * objects the advisor does - never flagging a Supabase-managed index, never
 * missing a custom app schema.
 *
 *   bun run scripts/check-schemas-drift.ts        # warn on drift, exit 0
 *   SBPERF_SCHEMAS_STRICT=1 bun run ...           # exit 1 on dangerous drift
 *
 * The invariant is a SUPERSET, not equality: NON_APP_SCHEMAS must contain every
 * schema splinter excludes (otherwise we would flag a managed object the advisor
 * ignores - the failure case). Extra entries beyond splinter's list are fine and
 * expected (we exclude a few more internal schemas defensively) - reported as
 * informational, never a failure.
 */

import { NON_APP_SCHEMAS } from "../src/appschema.ts";

const IN_GHA = process.env.GITHUB_ACTIONS === "true";
const STRICT = process.env.SBPERF_SCHEMAS_STRICT === "1";
const warn = (m: string): void => console.error(IN_GHA ? `::warning::${m}` : `warning: ${m}`);

const splinterPath = new URL("../src/splinter.sql", import.meta.url).pathname;
const sql = await Bun.file(splinterPath).text();

// The unused_index lint scopes with `... schemaname not in ( '<a>', '<b>', ... )`
// right after its `'unused_index' as name` marker. Anchor on the marker so we
// read THAT lint's exclusion set, not some other lint's narrower one.
const marker = "'unused_index' as name";
const at = sql.indexOf(marker);
if (at === -1) {
  warn(`could not find the unused_index lint in ${splinterPath} - has splinter's format changed?`);
  process.exit(STRICT ? 1 : 0);
}
const block = sql.slice(at).match(/schemaname\s+not\s+in\s*\(([^)]*)\)/);
if (!block) {
  warn(`could not parse the unused_index schema exclusion list in ${splinterPath}`);
  process.exit(STRICT ? 1 : 0);
}
const upstream = new Set([...block[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!));

if (upstream.size === 0) {
  warn(`no schemas parsed from the unused_index exclusion list - check the regex`);
  process.exit(STRICT ? 1 : 0);
}

// Dangerous drift: splinter excludes a schema we would treat as the user's app
// (we would flag a managed object the advisor ignores).
const missing = [...upstream].filter((s) => !NON_APP_SCHEMAS.has(s)).sort();
// Informational: we are stricter than splinter (safe, expected).
const extra = [...NON_APP_SCHEMAS].filter((s) => !upstream.has(s)).sort();

if (!missing.length) {
  const note = extra.length
    ? ` (+${extra.length} extra we exclude defensively: ${extra.join(", ")})`
    : "";
  console.error(
    `NON_APP_SCHEMAS covers all ${upstream.size} splinter unused_index exclusions${note}`,
  );
  process.exit(0);
}

warn(
  `${missing.length} schema(s) excluded by splinter.sql's unused_index lint are MISSING from ` +
    `NON_APP_SCHEMAS in src/appschema.ts - sbperf would flag their (Supabase-managed) objects ` +
    `the advisor ignores. Add them: ${missing.join(", ")}`,
);
process.exit(STRICT ? 1 : 0);
