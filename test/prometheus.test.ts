import { afterEach, describe, expect, test } from "bun:test";
import { fetchTrends } from "../src/prometheus.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Capture the query= param from each range request the fetch would make. */
function captureQueries(): { urls: string[] } {
  const urls: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    urls.push(String(url));
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
