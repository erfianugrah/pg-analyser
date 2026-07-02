import { describe, expect, test } from "bun:test";
import { render, renderIndex } from "../src/report/render.ts";
import type { Analysis } from "../src/schemas.ts";

function fixture(overrides: Partial<Analysis> = {}): Analysis {
  const base: Analysis = {
    meta: {
      ref: "testref",
      name: "test-project",
      region: "eu-central-1",
      status: "ACTIVE_HEALTHY",
      pgVersion: "17.6.1.104",
      createdAt: "2026-01-01T00:00:00Z",
      collectedAt: "2026-07-02T00:00:00Z",
      transport: "direct",
      sbperfVersion: "0.1.0",
    },
    health: [
      { name: "db", healthy: true, status: "ACTIVE_HEALTHY" },
      { name: "realtime", healthy: false, status: "UNHEALTHY" },
    ],
    disk: {
      sizeGb: 8,
      iops: 3000,
      type: "gp3",
      throughputMibps: 125,
      usedBytes: 972496896,
      availBytes: 7444385792,
    },
    pgConfig: { max_connections: 60, shared_buffers: "256MB" },
    pooler: [{ database_type: "PRIMARY", db_port: 6543, pool_mode: "transaction" }],
    backups: { pitr_enabled: false, walg_enabled: true, backups: [] },
    upgrade: { eligible: true, current_app_version: "v1", latest_app_version: "v2" },
    functions: [],
    buckets: [],
    advisors: {
      performance: [
        { name: "x", title: "Multiple Permissive Policies", level: "WARN", detail: "detail here" },
      ],
      security: [],
    },
    apiCounts: [{ timestamp: "2026-07-01T06:00:00", total_rest_requests: 2 }],
    sql: {
      dbSize: "20 MB",
      cacheHitPct: 100,
      pgSettings: [
        { name: "max_connections", setting: "60", unit: null },
        { name: "idle_in_transaction_session_timeout", setting: "0", unit: "ms" },
      ],
      topStatements: [{ total_ms: 50983.4, calls: 135, query: "SELECT ..." }],
      biggestTables: [],
      unusedIndexes: [],
      seqScanHeavy: [],
      deadTuples: [],
      rlsPolicies: [
        { table: "public.pastes", policyname: "view own", cmd: "SELECT", unwrapped_auth: true },
      ],
      connections: [{ state: "idle", connections: 3 }],
      storageUsage: [],
    },
    metrics: {
      available: true,
      samples: [{ name: "node_load1", labels: { service_type: "db" }, value: 0.42 }],
    },
    trends: [],
    errors: [],
  };
  return { ...base, ...overrides };
}

function tagBalance(html: string): boolean {
  const void_ = new Set(["meta", "br", "hr", "img", "input", "link"]);
  const stack: string[] = [];
  const re = /<(\/?)([a-z0-9]+)[^>]*?(\/?)>/gi;
  let m: RegExpExecArray | null;
  m = re.exec(html);
  while (m !== null) {
    const [, close, tag, selfClose] = m;
    const t = tag!.toLowerCase();
    if (t === "!doctype" || void_.has(t) || selfClose) {
      // ignore
    } else if (close) {
      const idx = stack.lastIndexOf(t);
      if (idx === -1) return false;
      stack.length = idx;
    } else {
      stack.push(t);
    }
    m = re.exec(html);
  }
  return stack.length === 0;
}

describe("render", () => {
  test("emits all section headings", () => {
    const html = render(fixture());
    for (const h of [
      "Service health",
      "Infrastructure",
      "Advisors - performance",
      "Query outliers",
      "Unused indexes",
      "Infra metrics",
    ]) {
      expect(html).toContain(h);
    }
  });

  test("renders advisor finding with level badge", () => {
    const html = render(fixture());
    expect(html).toContain("Multiple Permissive Policies");
    expect(html).toContain('class="lvl WARN"');
  });

  test("empty SQL sections show 'none found' not a broken table", () => {
    const html = render(fixture());
    expect(html).toContain("none found");
  });

  test("leads with a findings summary (pyramid apex)", () => {
    const html = render(fixture());
    const findIdx = html.indexOf("<h2>Findings</h2>");
    const outlierIdx = html.indexOf("Query outliers");
    expect(findIdx).toBeGreaterThan(-1);
    expect(findIdx).toBeLessThan(outlierIdx); // findings before detail
    expect(html).toContain("RLS"); // the unwrapped-auth finding surfaces
  });

  test("degraded banner shows for non-healthy status", () => {
    const html = render(fixture({ meta: { ...fixture().meta, status: "INACTIVE" } }));
    expect(html).toContain("banner bad");
    expect(html).toContain('not "clean"');
  });

  test("deduped collection notes collapse repeats", () => {
    const html = render(
      fixture({
        errors: [
          { source: "sql:dbSize", message: "connection timeout" },
          { source: "sql:cacheHit", message: "connection timeout" },
        ],
      }),
    );
    expect(html).toContain("2x");
  });

  test("empty advisors show 'no findings'", () => {
    const html = render(fixture({ advisors: { performance: [], security: [] } }));
    expect(html).toContain("no findings");
  });

  test("flags unhealthy service + version drift + sub-99 cache", () => {
    const html = render(fixture({ sql: { ...fixture().sql, cacheHitPct: 92 } }));
    expect(html).toContain('class="badge bad">realtime');
    expect(html).toContain("available</span>");
    expect(html).toContain("below 99%");
  });

  test("renders SVG sparklines when trends present", () => {
    const html = render(
      fixture({
        trends: [
          {
            title: "CPU load (1m)",
            unit: "",
            points: [
              { t: 1, v: 0.5 },
              { t: 2, v: 0.9 },
            ],
          },
        ],
      }),
    );
    expect(html).toContain("30-day trends");
    expect(html).toContain("<svg viewBox");
  });

  test("omits trends section when no trend data", () => {
    expect(render(fixture())).not.toContain("30-day trends");
  });

  test("storage buckets render with access + usage", () => {
    const html = render(
      fixture({
        buckets: [{ name: "avatars", public: true }],
        sql: {
          ...fixture().sql,
          storageUsage: [{ bucket_id: "avatars", objects: 12, size: "3 MB" }],
        },
      }),
    );
    expect(html).toContain("avatars");
    expect(html).toContain("public");
    expect(html).toContain("3 MB");
  });

  test("produces balanced HTML tags", () => {
    expect(tagBalance(render(fixture()))).toBe(true);
  });

  test("is self-contained (no external asset refs)", () => {
    const html = render(fixture());
    expect(html).not.toMatch(/<(script|link)[^>]+(src|href)=["']https?:/);
  });
});

describe("renderIndex", () => {
  test("links each project with status + findings counts", () => {
    const html = renderIndex(
      [
        {
          name: "proj-a",
          ref: "aaa",
          status: "ACTIVE_HEALTHY",
          high: 0,
          med: 2,
          low: 5,
          dir: "aaa",
        },
        {
          name: "proj-b",
          ref: "bbb",
          status: "INACTIVE",
          high: 0,
          med: 0,
          low: 0,
          dir: "bbb",
          error: "unreachable",
        },
      ],
      "2026-07-02T00:00:00Z",
    );
    expect(html).toContain('href="aaa/report.html"');
    expect(html).toContain("proj-a");
    expect(html).toContain("0 / 2 / 5");
    expect(html).toContain("unreachable"); // failed project shows its error
    expect(html).toContain("2 projects");
  });
});
