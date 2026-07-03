import { describe, expect, test } from "bun:test";
import { HEURISTICS_REVIEWED } from "../src/heuristics.ts";
import { SPLINTER_SQL } from "../src/splinter.ts";
import { catalogAgeDays, computeSyncStatus, stripLeadingComments } from "../src/sync.ts";

const okFetch = (body: string): typeof fetch =>
  (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
const failFetch: typeof fetch = (async () => {
  throw new Error("offline");
}) as unknown as typeof fetch;

describe("catalogAgeDays", () => {
  test("computes whole days from a YYYY-MM vintage", () => {
    expect(catalogAgeDays("2026-01", new Date("2026-01-31T00:00:00Z"))).toBe(30);
    expect(catalogAgeDays("2026-01", new Date("2026-01-01T00:00:00Z"))).toBe(0);
  });
  test("clamps negatives (future vintage) to 0", () => {
    expect(catalogAgeDays("2030-01", new Date("2026-01-01T00:00:00Z"))).toBe(0);
  });
  test("returns 0 for a malformed vintage", () => {
    expect(catalogAgeDays("nope", new Date())).toBe(0);
  });
});

describe("stripLeadingComments", () => {
  test("drops a leading header + blank lines but keeps the body", () => {
    const s = stripLeadingComments("-- header a\n-- header b\n\nselect 1;\n-- inline\nselect 2;");
    expect(s).toBe("select 1;\n-- inline\nselect 2;");
  });
  test("a local header does not read as drift vs a header-less upstream", async () => {
    const upstream = "select 1;\nselect 2;";
    const vendored = `-- local provenance note\n-- @ 2026-07-03\n${upstream}`;
    const s = await computeSyncStatus({
      vendored,
      fetchImpl: (async () => new Response(upstream, { status: 200 })) as unknown as typeof fetch,
    });
    expect(s.advisorSqlDrifted).toBe(false);
  });
});

describe("computeSyncStatus", () => {
  test("offline path: soft-fails, records the catalog vintage, skips upstream", async () => {
    const s = await computeSyncStatus({ fetchImpl: failFetch, now: new Date("2026-07-15") });
    expect(s.catalogReviewed).toBe(HEURISTICS_REVIEWED);
    expect(s.upstreamChecked).toBe(false);
    expect(s.advisorSqlDrifted).toBeNull();
    expect(s.note).toContain("skipped");
  });

  test("check disabled: no fetch attempted", async () => {
    let called = false;
    const spy: typeof fetch = (async () => {
      called = true;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    const s = await computeSyncStatus({ check: false, fetchImpl: spy });
    expect(called).toBe(false);
    expect(s.upstreamChecked).toBe(false);
  });

  test("upstream matches vendored -> no drift", async () => {
    const s = await computeSyncStatus({ fetchImpl: okFetch(SPLINTER_SQL) });
    expect(s.upstreamChecked).toBe(true);
    expect(s.advisorSqlDrifted).toBe(false);
    expect(s.note).toContain("matches upstream");
  });

  test("upstream differs from vendored -> drift flagged", async () => {
    const s = await computeSyncStatus({ fetchImpl: okFetch(`${SPLINTER_SQL}\n-- changed`) });
    expect(s.advisorSqlDrifted).toBe(true);
    expect(s.note).toContain("re-review src/splinter.sql");
  });

  test("stale vintage (>~6 months) is flagged in the note", async () => {
    const s = await computeSyncStatus({
      fetchImpl: failFetch,
      now: new Date("2030-01-01"),
    });
    expect(s.stale).toBe(true);
    expect(s.note).toContain("re-review recommended");
  });
});
