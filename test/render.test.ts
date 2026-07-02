import { describe, expect, test } from "bun:test";
import { render } from "../src/report/render.ts";
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
      topStatements: [{ total_ms: 50983.4, calls: 135, query: "SELECT ..." }],
      biggestTables: [],
      unusedIndexes: [],
      seqScanHeavy: [],
      deadTuples: [],
      connections: [{ state: "idle", connections: 3 }],
    },
    metrics: {
      available: true,
      samples: [{ name: "node_load1", labels: { service_type: "db" }, value: 0.42 }],
    },
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

  test("empty SQL sections show 'none' not a broken table", () => {
    const html = render(fixture());
    expect(html).toContain("<p class=empty>none</p>");
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

  test("produces balanced HTML tags", () => {
    expect(tagBalance(render(fixture()))).toBe(true);
  });

  test("is self-contained (no external asset refs)", () => {
    const html = render(fixture());
    expect(html).not.toMatch(/<(script|link)[^>]+(src|href)=["']https?:/);
  });
});
