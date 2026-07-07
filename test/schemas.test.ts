import { describe, expect, test } from "bun:test";
import * as S from "../src/schemas.ts";
import advisorsCli from "./fixtures/api/advisors-cli.json";
import advisorsPerf from "./fixtures/api/advisors-performance.json";
import apiCounts from "./fixtures/api/api-counts.json";
import disk from "./fixtures/api/disk.json";
import diskUtil from "./fixtures/api/disk-util.json";
import health from "./fixtures/api/health.json";
import pooler from "./fixtures/api/pooler.json";
import project from "./fixtures/api/project.json";
import topStatements from "./fixtures/api/sql-top-statements.json";

describe("Management API schemas parse real-shaped fixtures", () => {
  test("Project", () => {
    const p = S.Project.parse(project);
    expect(p.name).toBe("example-project");
    expect(p.database?.version).toBe("17.6.1.104");
  });

  test("HealthList flags unhealthy service", () => {
    const h = S.HealthList.parse(health);
    expect(h.find((s) => s.name === "realtime")?.healthy).toBe(false);
  });

  test("DiskConfig + DiskUtil", () => {
    expect(S.DiskConfig.parse(disk).attributes.iops).toBe(3000);
    expect(S.DiskUtil.parse(diskUtil).metrics.fs_used_bytes).toBe(972496896);
  });

  test("PoolerConfig", () => {
    expect(S.PoolerConfig.parse(pooler)[0]?.pool_mode).toBe("transaction");
  });

  test("ApiCounts", () => {
    expect(S.ApiCounts.parse(apiCounts).result).toHaveLength(2);
  });

  test("SqlRows", () => {
    const rows = S.SqlRows.parse(topStatements);
    expect(rows[0]?.calls).toBe(135);
  });
});

describe("AdvisorResponse accepts both shapes, fails loud otherwise", () => {
  test("REST `lints` shape", () => {
    expect(S.AdvisorResponse.parse(advisorsPerf)).toHaveLength(2);
  });

  test("CLI `results` shape", () => {
    expect(S.AdvisorResponse.parse(advisorsCli)).toHaveLength(1);
  });

  test("throws when neither lints nor results present", () => {
    expect(() => S.AdvisorResponse.parse({ foo: [] })).toThrow();
  });
});

describe("AuthConfig tolerates the API's nullable fields", () => {
  test("password_required_characters: null (no char-class requirement) parses", () => {
    const parsed = S.AuthConfig.parse({
      disable_signup: false,
      password_min_length: 8,
      password_required_characters: null,
    });
    expect(parsed.password_required_characters).toBeNull();
    expect(parsed.password_min_length).toBe(8);
  });

  test("password_required_characters: a real char-class string parses", () => {
    const parsed = S.AuthConfig.parse({
      password_required_characters: "abcdefghijklmnopqrstuvwxyz:ABC",
    });
    expect(parsed.password_required_characters).toContain("abc");
  });
});
