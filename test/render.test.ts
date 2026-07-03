import { describe, expect, test } from "bun:test";
import { render, renderIndex, renderSummary } from "../src/report/render.ts";
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
      sbperfVersion: "0.1.0",
      sqlSource: "read-only",
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
    functionStats: [],
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
      indexHitPct: 99.9,
      statsResetAge: "8 days 01:02:03",
      pgSettings: [
        { name: "max_connections", setting: "60", unit: null },
        { name: "idle_in_transaction_session_timeout", setting: "0", unit: "ms" },
      ],
      topStatements: [{ total_ms: 50983.4, calls: 135, pct: 88.2, query: "SELECT ..." }],
      topByCalls: [],
      biggestTables: [],
      indexStats: [],
      duplicateIndexes: [],
      rlsUnindexed: [],
      seqScanHeavy: [],
      bloat: [],
      trafficProfile: [],
      deadTuples: [],
      txidWraparound: [],
      replicationSlots: [],
      rlsPolicies: [
        { table: "public.pastes", policyname: "view own", cmd: "SELECT", unwrapped_auth: true },
      ],
      connections: [{ state: "idle", connections: 3 }],
      roleStats: [],
      longRunning: [],
      locks: [],
      blocking: [],
      storageUsage: [],
    },
    metrics: {
      available: true,
      samples: [{ name: "node_load1", labels: { service_type: "db" }, value: 0.42 }],
    },
    trends: [],
    sync: null,
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
      "Index usage",
      "Estimated bloat",
      "Read/write profile",
      "Blocking chains",
      "Infra metrics",
    ]) {
      expect(html).toContain(h);
    }
  });

  test("query outliers render an inline-SVG bar chart", () => {
    const html = render(fixture());
    expect(html).toContain("table class=chart");
    expect(html).toContain("<svg class=bar");
  });

  test("findings summary includes a severity bar when findings exist", () => {
    const html = render(fixture());
    expect(html).toContain('class="sevbar"');
  });

  test("sync footer renders the catalog vintage + drift note when present", () => {
    const html = render(
      fixture({
        sync: {
          catalogReviewed: "2026-07",
          ageDays: 2,
          stale: false,
          upstreamChecked: true,
          advisorSqlDrifted: true,
          note: "Heuristics catalog vintage 2026-07 (current). Upstream advisor lint SQL changed since it was vendored - re-review src/splinter.sql.",
        },
      }),
    );
    expect(html).toContain("Heuristics sync:");
    expect(html).toContain("vintage 2026-07");
    expect(html).toContain("always current");
  });

  test("sync footer omitted when no sync status recorded (back-compat)", () => {
    expect(render(fixture())).not.toContain("Heuristics sync:");
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

describe("renderSummary", () => {
  test("healthy project -> ok verdict, no issues", () => {
    const clean = fixture({
      advisors: { performance: [], security: [] },
      upgrade: null,
      sql: {
        dbSize: "20 MB",
        cacheHitPct: 100,
        indexHitPct: 100,
        statsResetAge: null,
        pgSettings: [],
        topStatements: [],
        topByCalls: [],
        biggestTables: [],
        indexStats: [],
        duplicateIndexes: [],
        rlsUnindexed: [],
        seqScanHeavy: [],
        bloat: [],
        trafficProfile: [],
        deadTuples: [],
        txidWraparound: [],
        replicationSlots: [],
        rlsPolicies: [],
        connections: [],
        roleStats: [],
        longRunning: [],
        locks: [],
        blocking: [],
        storageUsage: [],
      },
    });
    const html = renderSummary(clean);
    expect(html).toContain("Healthy - no issues found");
    expect(html).not.toContain("needs attention");
  });

  test("high finding -> singular subject-verb agreement", () => {
    const a = fixture();
    a.functionStats = [
      {
        slug: "boom",
        requests: 5,
        success: 0,
        clientErr: 0,
        serverErr: 5,
        avgExecMs: 1,
        maxExecMs: 1,
      },
    ];
    const html = renderSummary(a);
    expect(html).toContain("1 issue needs attention now");
    expect(html).toContain("boom");
    expect(html).not.toContain("1 issue need attention");
  });

  test("is standalone: no SQL evidence tables or drill anchors", () => {
    const html = renderSummary(fixture());
    expect(html).not.toContain("pg_stat_statements");
    expect(html).not.toContain("#txid");
    expect(html).toContain("At a glance");
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
