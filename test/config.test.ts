import { describe, expect, test } from "bun:test";
import { ConfigError, loadConfig } from "../src/config.ts";

describe("loadConfig", () => {
  test("resolves the access token", () => {
    const c = loadConfig({ SUPABASE_ACCESS_TOKEN: "sbp_x" } as NodeJS.ProcessEnv);
    expect(c).toEqual({ accessToken: "sbp_x" });
  });

  test("throws when the token is missing", () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(ConfigError);
  });

  test("throws when the token is empty", () => {
    expect(() => loadConfig({ SUPABASE_ACCESS_TOKEN: "" } as NodeJS.ProcessEnv)).toThrow(
      ConfigError,
    );
  });
});
