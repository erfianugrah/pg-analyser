import type { SqlRow } from "./schemas.ts";

/**
 * Schemas that are NOT the user's application: Postgres internals, Supabase-
 * managed service schemas, and common extension schemas.
 *
 * This mirrors the exclusion set baked into splinter.sql's `unused_index` and
 * `duplicate_index` lints (see src/splinter.sql), so sbperf's SQL-derived
 * findings and the narrate evidence digest count the SAME objects the advisor
 * does: we never flag a Supabase-managed index (e.g. an `auth` internal index)
 * and never miss a custom application schema (e.g. `app1`). The previous
 * heuristic - `schema === "public"` - silently under-reported every project
 * that keeps its tables outside `public`.
 *
 * Keep in sync with the schema denylist in src/splinter.sql. A schema that is
 * unknown here is treated as an application schema (fail-open), so a new
 * user schema is never silently dropped.
 */
export const NON_APP_SCHEMAS: ReadonlySet<string> = new Set([
  "_analytics",
  "_realtime",
  "_timescaledb_cache",
  "_timescaledb_catalog",
  "_timescaledb_config",
  "_timescaledb_internal",
  "auth",
  "cron",
  "extensions",
  "graphql",
  "graphql_public",
  "information_schema",
  "net",
  "pg_catalog",
  "pg_toast",
  "pgbouncer",
  "pgmq",
  "pgroonga",
  "pgsodium",
  "pgsodium_masks",
  "pgtle",
  "realtime",
  "repack",
  "storage",
  "supabase_functions",
  "supabase_migrations",
  "tiger",
  "topology",
  "vault",
]);

/**
 * True when `schema` is a user application schema (not a Postgres-internal or
 * Supabase-managed one). A blank/absent schema is NOT an app schema (the row
 * carries no schema attribution, so we cannot claim it as the user's).
 */
export function isAppSchema(schema: unknown): boolean {
  const s = String(schema ?? "").trim();
  return s.length > 0 && !NON_APP_SCHEMAS.has(s);
}

/** Filter SQL rows to those in a user application schema (keyed on `.schema`). */
export function appRows(rows: SqlRow[]): SqlRow[] {
  return rows.filter((r) => isAppSchema(r.schema));
}

/**
 * The denylist rendered as a single-quoted SQL value list, for embedding in a
 * `WHERE <schema-col> NOT IN (${NON_APP_SCHEMAS_SQL})` clause. Used by the
 * app-object-inventory queries in sql.ts (index usage, duplicate indexes,
 * seq-scan-heavy) so a Supabase-managed object never counts against those
 * queries' row cap and crowd out the user's own tables. All entries are static
 * identifiers (no user input), so direct interpolation is safe.
 */
export const NON_APP_SCHEMAS_SQL: string = [...NON_APP_SCHEMAS].map((s) => `'${s}'`).join(", ");
