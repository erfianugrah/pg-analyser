import { describe, expect, test } from "bun:test";
import { QUERIES } from "../src/sql.ts";

// card11: the 160-char query cut hid the PostgREST RPC function name, so the
// top statement could not be named. rpc_fn carries it from the full text.
const RPC_STATEMENTS = ["topStatements", "topByCalls", "queryIoStats", "topByWal"] as const;

// Same pattern as RPC_FN_SQL in src/sql.ts, evaluated in JS for the unit test.
const RPC_FN = /("[^"]+"\."[^"]+")\(/;

// Hand-written sample of the PostgREST RPC shape (no PostgREST binary on this box);
// the function name follows a long parameter list, as the card describes.
const PGRST_RPC =
  "WITH pgrst_source AS (SELECT pgrst_call.* FROM (SELECT $1 AS json_data) pgrst_payload, " +
  'LATERAL (SELECT "p_status" := pgrst_payload.json_data->>$2, "p_since" := (pgrst_payload.json_data->>$3)::timestamptz, ' +
  '"p_region" := pgrst_payload.json_data->>$4, "p_limit" := (pgrst_payload.json_data->>$5)::int, ' +
  '"p_offset" := (pgrst_payload.json_data->>$6)::int) pgrst_args, "public"."get_orders_summary"(' +
  "pgrst_args) pgrst_call) " +
  "SELECT pg_catalog.count(_postgrest_t) AS total FROM pgrst_source _postgrest_t";

describe("card11: top-statement rows carry the RPC function name", () => {
  for (const name of RPC_STATEMENTS) {
    test(`${name} selects rpc_fn from the full query text`, () => {
      const q = QUERIES[name];
      expect(q).toContain("as rpc_fn");
      expect(q).toContain("case when query ilike '%pgrst_source%'");
      // the name is read before the 160-char cut, not from the cut text
      expect(q.indexOf("as rpc_fn")).toBeLessThan(q.indexOf("left(regexp_replace(query"));
    });
  }

  test("the pattern extracts the RPC function past the parameter list", () => {
    // the name must sit beyond the 160-char cut, or the test proves nothing
    expect(PGRST_RPC.indexOf("get_orders_summary")).toBeGreaterThan(160);
    expect(PGRST_RPC.match(RPC_FN)?.[1]).toBe('"public"."get_orders_summary"');
  });

  test("pg_catalog.count is not mistaken for the RPC", () => {
    const onlyCount = "SELECT pg_catalog.count(_postgrest_t) FROM pgrst_source _postgrest_t";
    expect(onlyCount.match(RPC_FN)).toBeNull();
  });
});
