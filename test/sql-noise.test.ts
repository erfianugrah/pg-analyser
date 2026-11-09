import { describe, expect, test } from "bun:test";
import { lintFix } from "../src/lints.ts";
import { QUERIES } from "../src/sql.ts";

// PostgREST's request queries (the Data API workload) are all
// `WITH pgrst_source AS (...)` and also contain pg_catalog.count(...) and
// current_setting('response.headers', ...), which the platform-noise patterns
// match - so every query that applies the noise filter must keep them.
describe("platform-noise filter keeps Data API queries", () => {
  const filtered = Object.entries(QUERIES).filter(([, q]) => q.includes("not ilike all"));

  test("the filter is in use", () => {
    expect(filtered.length).toBeGreaterThanOrEqual(6);
  });

  for (const [name, q] of filtered) {
    test(`${name} keeps pgrst_source statements`, () => {
      expect(q).toContain("or query ilike '%pgrst_source%'");
    });
  }
});

describe("SECURITY DEFINER exec lint fixes revoke from PUBLIC too", () => {
  // Postgres grants EXECUTE to PUBLIC on every new function and anon inherits
  // it: on PG17 `revoke ... from anon` alone left anon able to execute; only
  // adding `from public` removed it (Supabase functions docs, Function
  // privileges, revoke from both).
  for (const name of [
    "anon_security_definer_function_executable",
    "authenticated_security_definer_function_executable",
  ]) {
    test(`${name} sql revokes from PUBLIC`, () => {
      expect(lintFix(name)?.sql).toMatch(/FROM PUBLIC, /);
    });
  }
});
