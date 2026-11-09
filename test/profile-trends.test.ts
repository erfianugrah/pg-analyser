import { describe, expect, test } from "bun:test";
import { profileTrendOpts } from "../src/index.ts";
import { parseProfile } from "../src/profile.ts";

const REF = "abcdefghijklmnopqrst";
const prof = parseProfile(
  JSON.stringify({
    trendDays: 90,
    grafana: {
      hostTemplate: "https://grafana-{region}.example.com",
      datasourceUid: "DS",
      regions: { "ap-southeast-1": { cookie: "c-sg" } },
    },
    databases: [{ dbUrl: "postgresql://a" }],
  }),
);

describe("profileTrendOpts", () => {
  test("a profile target resolves its regional Grafana (analyze --profile and full share this)", () => {
    expect(
      profileTrendOpts({ ref: REF, dbUrl: "x", region: "ap-southeast-1", profile: prof }),
    ).toEqual({
      prometheusUrl: "https://grafana-ap-southeast-1.example.com/api/datasources/proxy/uid/DS",
      prometheusCookie: "c-sg",
      prometheusMatcher: 'supabase_project_ref="{ref}"',
      trendDays: 90,
    });
  });

  test("no profile falls back to --prometheus", () => {
    expect(profileTrendOpts({ ref: REF, dbUrl: "x" }, "https://prom.example")).toEqual({
      prometheusUrl: "https://prom.example",
      prometheusCookie: undefined,
      prometheusMatcher: undefined,
      trendDays: undefined,
    });
  });
});
