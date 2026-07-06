import { describe, expect, test } from "bun:test";
import { Management } from "../src/management.ts";
import advisorsPerf from "./fixtures/api/advisors-performance.json";
import health from "./fixtures/api/health.json";
import project from "./fixtures/api/project.json";
import { fakeTransport, jsonResponse, textResponse } from "./helpers.ts";

const ROUTES: Record<string, unknown> = {
  "/v1/projects/ref": project,
  "/v1/projects/ref/advisors/performance": advisorsPerf,
};

function route(path: string): Response {
  // strip query string
  const clean = path.split("?")[0]!;
  if (clean.endsWith("/health")) return jsonResponse(health);
  const body = ROUTES[clean];
  return body ? jsonResponse(body) : textResponse("not found", 404);
}

describe("Management", () => {
  test("project() parses and returns typed project", async () => {
    const t = fakeTransport({ onMgmt: route });
    const m = new Management(t);
    const p = await m.project("ref");
    expect(p.name).toBe("example-project");
    expect(t.calls.mgmt).toContain("/v1/projects/ref");
  });

  test("advisors() unwraps `lints`", async () => {
    const m = new Management(fakeTransport({ onMgmt: route }));
    const a = await m.advisors("ref", "performance");
    expect(a).toHaveLength(2);
    expect(a[0]?.name).toBe("unindexed_foreign_keys");
  });

  test("health() hits the health endpoint with service list", async () => {
    const t = fakeTransport({ onMgmt: route });
    await new Management(t).health("ref");
    expect(t.calls.mgmt.some((p) => p.startsWith("/v1/projects/ref/health?services="))).toBe(true);
  });

  test("non-2xx throws with path + status", async () => {
    const m = new Management(fakeTransport({ onMgmt: () => textResponse("boom", 500) }));
    await expect(m.project("ref")).rejects.toThrow(/500/);
  });

  test("authConfig() parses the GoTrue auth config", async () => {
    const t = fakeTransport({
      onMgmt: (p) =>
        p.endsWith("/config/auth")
          ? jsonResponse({ mailer_autoconfirm: true, jwt_exp: 3600, extra_unknown: 1 })
          : textResponse("nope", 404),
    });
    const c = await new Management(t).authConfig("ref");
    expect(c.mailer_autoconfirm).toBe(true);
    expect(c.jwt_exp).toBe(3600);
    expect(t.calls.mgmt).toContain("/v1/projects/ref/config/auth");
  });

  test("networkRestrictions() parses the CIDR allowlist", async () => {
    const t = fakeTransport({
      onMgmt: (p) =>
        p.endsWith("/network-restrictions")
          ? jsonResponse({
              entitlement: "allowed",
              config: { dbAllowedCidrs: ["10.0.0.0/8"] },
              status: "applied",
            })
          : textResponse("nope", 404),
    });
    const nr = await new Management(t).networkRestrictions("ref");
    expect(nr.config?.dbAllowedCidrs).toEqual(["10.0.0.0/8"]);
  });

  test("sslEnforcement() parses the enforcement flag", async () => {
    const t = fakeTransport({
      onMgmt: (p) =>
        p.endsWith("/ssl-enforcement")
          ? jsonResponse({ currentConfig: { database: true }, appliedSuccessfully: true })
          : textResponse("nope", 404),
    });
    const ssl = await new Management(t).sslEnforcement("ref");
    expect(ssl.currentConfig.database).toBe(true);
  });

  test("readOnlySql posts the query body and parses rows", async () => {
    let seenBody: string | undefined;
    const t = fakeTransport({
      onMgmt: (path, init) => {
        if (path.endsWith("/database/query/read-only")) {
          seenBody = init?.body as string;
          return jsonResponse([{ n: 1 }]);
        }
        return textResponse("nope", 404);
      },
    });
    const rows = await new Management(t).readOnlySql("ref", "select 1 as n");
    expect(rows).toEqual([{ n: 1 }]);
    expect(JSON.parse(seenBody!).query).toBe("select 1 as n");
  });
});
