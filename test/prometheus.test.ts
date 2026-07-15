import { afterEach, describe, expect, test } from "bun:test";
import { fetchIncidentSeries, fetchTrends } from "../src/prometheus.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Capture the query= param from each range request the fetch would make. */
function captureQueries(): { urls: string[] } {
  const urls: string[] = [];
  const now = Math.floor(Date.now() / 1000);
  globalThis.fetch = (async (url: string | URL | Request) => {
    const u = String(url);
    // The dataStart probe (instant /api/v1/query): report data began at ~now so
    // these scoping tests never trigger the re-scope pass. Not a panel query, so
    // keep it out of the captured range-URL list.
    if (u.includes("/api/v1/query?"))
      return new Response(
        JSON.stringify({ status: "success", data: { result: [{ value: [now, String(now)] }] } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    urls.push(u);
    // one data point per panel so the happy path completes (all-empty throws)
    return new Response(
      JSON.stringify({ status: "success", data: { result: [{ values: [[1, "1"]] }] } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  return { urls };
}

function decodedQueries(urls: string[]): string[] {
  return urls.map((u) => {
    const q = new URL(u).searchParams.get("query") ?? "";
    return q;
  });
}

describe("fetchTrends ref scoping", () => {
  test("with a ref, every query is scoped to that project", async () => {
    const cap = captureQueries();
    await fetchTrends("http://prom:9090", 30, "abcref");
    const queries = decodedQueries(cap.urls);
    expect(queries.length).toBeGreaterThan(0);
    // every panel query must carry the project-ref matcher
    for (const q of queries) {
      expect(q).toContain('supabase_project_ref="abcref"');
    }
    // the /data disk panel must keep its original mountpoint matcher too
    expect(queries.some((q) => q.includes('mountpoint="/data"'))).toBe(true);
    // rate() windows preserved
    expect(queries.some((q) => q.includes("[5m]"))).toBe(true);
  });

  test("without a ref, queries are unscoped (single-project scraper)", async () => {
    const cap = captureQueries();
    await fetchTrends("http://prom:9090");
    const queries = decodedQueries(cap.urls);
    for (const q of queries) {
      expect(q).not.toContain("supabase_project_ref");
    }
    // unscoped aggregates keep the bare metric form
    expect(queries).toContain("sum(pg_database_size_bytes)");
  });

  test("charts utilization %/rates, not raw values", async () => {
    const cap = captureQueries();
    await fetchTrends("http://prom:9090", 30, "r1");
    const queries = decodedQueries(cap.urls);
    // CPU as an idle-rate utilization %, not raw node_load1
    expect(
      queries.some((q) => q.includes("node_cpu_seconds_total") && q.includes('mode="idle"')),
    ).toBe(true);
    expect(queries.some((q) => q.includes("node_load1"))).toBe(false);
    // cache-hit ratio + transaction rate present
    expect(queries.some((q) => q.includes("pg_stat_database_blks_hit_total"))).toBe(true);
    expect(queries.some((q) => q.includes("pg_stat_database_xact_commit_total"))).toBe(true);
  });

  test("trailing slash on baseUrl is normalised", async () => {
    const cap = captureQueries();
    await fetchTrends("http://prom:9090/", 30, "r1");
    expect(cap.urls.every((u) => u.startsWith("http://prom:9090/api/v1/query_range?"))).toBe(true);
  });

  /** Capture the RequestInit of every fetch the range loop makes. */
  function captureInits(): (RequestInit | undefined)[] {
    const inits: (RequestInit | undefined)[] = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      inits.push(init);
      return new Response(
        JSON.stringify({ status: "success", data: { result: [{ values: [[1, "1"]] }] } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    return inits;
  }

  test("a token is sent as a Bearer Authorization header (Grafana proxy / auth'd DS)", async () => {
    const inits = captureInits();
    await fetchTrends("https://grafana/api/datasources/proxy/uid/abc", 30, "r1", {
      token: "secret-tok",
    });
    expect(inits.length).toBeGreaterThan(0);
    for (const init of inits) {
      const h = init?.headers as Record<string, string>;
      expect(h?.Authorization).toBe("Bearer secret-tok");
      expect(h?.Cookie).toBeUndefined();
    }
  });

  test("a cookie is sent as a Cookie header (SSO-fronted Grafana)", async () => {
    const inits = captureInits();
    await fetchTrends("https://grafana/api/datasources/proxy/uid/abc", 30, "r1", {
      cookie: "grafana_session=xyz",
    });
    expect(inits.length).toBeGreaterThan(0);
    for (const init of inits) {
      const h = init?.headers as Record<string, string>;
      expect(h?.Cookie).toBe("grafana_session=xyz");
      expect(h?.Authorization).toBeUndefined();
    }
  });

  test("token wins when both token and cookie are set", async () => {
    const inits = captureInits();
    await fetchTrends("https://grafana", 30, "r1", {
      token: "tok",
      cookie: "grafana_session=xyz",
    });
    for (const init of inits) {
      const h = init?.headers as Record<string, string>;
      expect(h?.Authorization).toBe("Bearer tok");
      expect(h?.Cookie).toBeUndefined();
    }
  });

  test("a matcher template overrides the default project label", async () => {
    const cap = captureQueries();
    // synthetic template - the {ref} placeholder is substituted with the ref
    await fetchTrends("http://prom:9090", 30, "abcref", { matcher: 'node_name="host-{ref}"' });
    const queries = decodedQueries(cap.urls);
    expect(queries.length).toBeGreaterThan(0);
    for (const q of queries) {
      expect(q).toContain('node_name="host-abcref"');
      expect(q).not.toContain("supabase_project_ref");
    }
  });

  test("no token -> no auth header (backward compatible)", async () => {
    const inits: (RequestInit | undefined)[] = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      inits.push(init);
      return new Response(
        JSON.stringify({ status: "success", data: { result: [{ values: [[1, "1"]] }] } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    await fetchTrends("http://prom:9090", 30, "r1");
    // no auth header set (init still carries redirect:"manual", so not undefined)
    for (const i of inits) {
      const h = (i?.headers ?? {}) as Record<string, string>;
      expect(h.Authorization).toBeUndefined();
      expect(h.Cookie).toBeUndefined();
    }
  });

  test("throws a clear, actionable error on an auth redirect (stale/absent cookie)", async () => {
    globalThis.fetch = (async (_u: string | URL | Request) =>
      new Response(null, {
        status: 302,
        headers: { location: "https://accounts.google.com/o/oauth2/auth?client_id=x" },
      })) as typeof fetch;
    await expect(
      fetchTrends("https://grafana/api/datasources/proxy/uid/x", 30, "r1"),
    ).rejects.toThrow(/redirected.*cookie\/token is missing or expired/);
  });

  test("throws when a 200 body isn't JSON (an SSO login HTML page)", async () => {
    globalThis.fetch = (async (_u: string | URL | Request) =>
      new Response("<html>sign in</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })) as typeof fetch;
    await expect(fetchTrends("https://grafana", 30, "r1")).rejects.toThrow(/non-JSON/);
  });

  test("throws on a prometheus query error (status:error in a 200 body)", async () => {
    globalThis.fetch = (async (_u: string | URL | Request) =>
      new Response(
        JSON.stringify({ status: "error", errorType: "bad_data", error: "parse error" }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      )) as typeof fetch;
    await expect(fetchTrends("https://grafana", 30, "r1")).rejects.toThrow(
      /query error.*parse error/,
    );
  });

  test("throws (not silent) when every panel returns 0 series - matcher/ref mismatch", async () => {
    globalThis.fetch = (async (_u: string | URL | Request) =>
      new Response(JSON.stringify({ status: "success", data: { result: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    await expect(
      fetchTrends("https://grafana", 30, "r1", { matcher: 'Name="x-{ref}"' }),
    ).rejects.toThrow(/all \d+ panels returned 0 series.*Name="x-r1"/);
  });
});

describe("fetchTrends adaptive window (auto-scope to real data span)", () => {
  const now = Math.floor(Date.now() / 1000);
  // Mock the range panels to return 3 points spanning `spanDays`, and the
  // dataStart probe (instant /api/v1/query) to report data began `spanDays` ago.
  // `probeStart` overrides what the probe reports (to simulate a coarse first
  // pass that hides the true start). Captures range-query URLs only.
  function mockSpanningDays(spanDays: number, probeStart = spanDays): string[] {
    const urls: string[] = [];
    const pts = [
      [now - spanDays * 86400, "1"],
      [now - (spanDays * 86400) / 2, "2"],
      [now, "3"],
    ];
    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = String(url);
      // Instant probe: min(min_over_time(timestamp(...))) -> the earliest sample.
      if (u.includes("/api/v1/query?")) {
        return new Response(
          JSON.stringify({
            status: "success",
            data: { result: [{ value: [now, String(now - probeStart * 86400)] }] },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      urls.push(u);
      return new Response(
        JSON.stringify({ status: "success", data: { result: [{ values: pts }] } }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as typeof fetch;
    return urls;
  }
  const distinctStarts = (urls: string[]) =>
    [...new Set(urls.map((u) => Number(new URL(u).searchParams.get("start"))))].sort(
      (a, b) => a - b,
    );

  test("young project (data fills << requested window) re-queries at its actual span", async () => {
    const urls = mockSpanningDays(7); // only 7d of data
    await fetchTrends("http://vm", 30, "r1"); // but we requested 30d
    const starts = distinctStarts(urls);
    expect(starts.length).toBe(2); // pass 1 (30d back) + re-query (7d back)
    expect(now - starts[0]!).toBeGreaterThan(28 * 86400); // pass 1 ~30d
    expect(now - starts[1]!).toBeLessThan(9 * 86400); // re-query ~7d
  });

  test("mature project (data fills the window) does NOT re-query", async () => {
    const urls = mockSpanningDays(30); // data spans the full 30d
    await fetchTrends("http://vm", 30, "r1");
    expect(distinctStarts(urls).length).toBe(1); // single pass
  });

  test("fresh scraper: coarse pass 1 hides the start, the probe re-scopes anyway", async () => {
    // The coarse 30d step returns a single tail point at ~now (pass 1 infers a
    // ~0 span, so the OLD logic never re-queried). The probe reports data began
    // ~1h ago, so the fix re-scopes to that actual span.
    const urls: string[] = [];
    const oneHourAgo = now - 3600;
    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/api/v1/query?"))
        return new Response(
          JSON.stringify({
            status: "success",
            data: { result: [{ value: [now, String(oneHourAgo)] }] },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      urls.push(u);
      return new Response(
        JSON.stringify({ status: "success", data: { result: [{ values: [[now, "1"]] }] } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    await fetchTrends("http://vm", 30, "r1");
    const starts = distinctStarts(urls);
    expect(starts.length).toBe(2); // pass 1 (~30d) + re-query (~1h)
    expect(now - starts[1]!).toBeLessThan(2 * 3600); // re-query window ~1h
  });

  test("probe failure falls back to the pass-1 inference", async () => {
    // Probe returns an empty result (metric/matcher mismatch) -> null -> the
    // old first-point inference still drives the re-scope.
    const urls: string[] = [];
    const pts = [
      [now - 7 * 86400, "1"],
      [now, "2"],
    ];
    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/api/v1/query?"))
        return new Response(JSON.stringify({ status: "success", data: { result: [] } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      urls.push(u);
      return new Response(
        JSON.stringify({ status: "success", data: { result: [{ values: pts }] } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    await fetchTrends("http://vm", 30, "r1");
    const starts = distinctStarts(urls);
    expect(starts.length).toBe(2); // fallback inference still re-queries at ~7d
    expect(now - starts[1]!).toBeLessThan(9 * 86400);
  });
});

describe("fetchIncidentSeries (native-resolution contention scan)", () => {
  test("pins step=300, probes families, skips absent series", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = String(url);
      // availability probe (instant query with count by (__name__))
      if (u.includes("/api/v1/query?") && u.includes("count")) {
        return new Response(
          JSON.stringify({
            status: "success",
            data: {
              result: [
                { metric: { __name__: "pg_stat_database_xact_rollback" }, value: [1, "1"] },
                { metric: { __name__: "pg_locks_count" }, value: [1, "1"] },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      urls.push(u);
      return new Response(
        JSON.stringify({
          status: "success",
          data: {
            result: [
              {
                values: [
                  [1000, "5"],
                  [1300, "80"],
                ],
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const s = await fetchIncidentSeries("http://prom", 7, "p1");
    expect(s.available).toContain("pg_stat_database_xact_rollback");
    // rollbacks + both lock-mode series present (families in the probe)
    expect(s.rollbacks).toBeDefined();
    expect(s.accessShare).toBeDefined();
    expect(s.accessExcl).toBeDefined();
    // pg_stat_activity_count NOT in the probe -> skipped, not errored
    expect(s.activeBackends).toBeUndefined();
    // every range query pinned to step=300
    const rangeUrls = urls.filter((u) => u.includes("query_range"));
    expect(rangeUrls.length).toBeGreaterThan(0);
    expect(rangeUrls.every((u) => u.includes("step=300"))).toBe(true);
    // ref scoping reached the query
    expect(rangeUrls.some((u) => decodeURIComponent(u).includes('supabase_project_ref="p1"'))).toBe(
      true,
    );
  });
});
