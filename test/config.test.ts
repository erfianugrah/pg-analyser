import { describe, expect, test } from "bun:test";
import { ConfigError, loadConfig } from "../src/config.ts";

describe("loadConfig", () => {
  test("direct mode from access token", () => {
    const c = loadConfig({ SUPABASE_ACCESS_TOKEN: "sbp_x" } as NodeJS.ProcessEnv);
    expect(c).toEqual({ kind: "direct", accessToken: "sbp_x" });
  });

  test("gatekeeper auto-detected when GATEKEEPER_URL present", () => {
    const c = loadConfig({
      GATEKEEPER_URL: "https://gate.example.com/",
      GATEKEEPER_KEY: "gk_x",
    } as NodeJS.ProcessEnv);
    expect(c).toEqual({ kind: "gatekeeper", baseUrl: "https://gate.example.com", key: "gk_x" });
  });

  test("trailing slashes stripped from baseUrl", () => {
    const c = loadConfig({
      GATEKEEPER_URL: "https://gate.example.com///",
      GATEKEEPER_KEY: "gk_x",
    } as NodeJS.ProcessEnv);
    expect((c as { baseUrl: string }).baseUrl).toBe("https://gate.example.com");
  });

  test("SBPERF_TRANSPORT overrides auto-detect", () => {
    // GATEKEEPER_URL present but forced to direct -> needs the token
    const c = loadConfig({
      SBPERF_TRANSPORT: "direct",
      SUPABASE_ACCESS_TOKEN: "sbp_x",
      GATEKEEPER_URL: "https://gate.example.com",
      GATEKEEPER_KEY: "gk_x",
    } as NodeJS.ProcessEnv);
    expect(c.kind).toBe("direct");
  });

  test("throws when direct without token", () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(ConfigError);
  });

  test("throws when gatekeeper without key", () => {
    expect(() =>
      loadConfig({ GATEKEEPER_URL: "https://gate.example.com" } as NodeJS.ProcessEnv),
    ).toThrow(/GATEKEEPER_KEY/);
  });

  test("throws on invalid GATEKEEPER_URL", () => {
    expect(() =>
      loadConfig({ GATEKEEPER_URL: "not-a-url", GATEKEEPER_KEY: "gk_x" } as NodeJS.ProcessEnv),
    ).toThrow(ConfigError);
  });
});
