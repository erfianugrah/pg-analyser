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
    return new Response(JSON.stringify({ status: "success", data: { result: [] } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
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

  test("a token is sent as a Bearer Authorization header (Grafana proxy / auth'd DS)", async () => {
    const inits: (RequestInit | undefined)[] = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      inits.push(init);
      return new Response(JSON.stringify({ status: "success", data: { result: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    await fetchTrends("https://grafana/api/datasources/proxy/uid/abc", 30, "r1", "secret-tok");
    expect(inits.length).toBeGreaterThan(0);
    for (const init of inits) {
      expect((init?.headers as Record<string, string>)?.Authorization).toBe("Bearer secret-tok");
    }
  });

  test("no token -> no auth header (backward compatible)", async () => {
    const inits: (RequestInit | undefined)[] = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      inits.push(init);
      return new Response(JSON.stringify({ status: "success", data: { result: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    await fetchTrends("http://prom:9090", 30, "r1");
    expect(inits.every((i) => i === undefined)).toBe(true);
  });
});
