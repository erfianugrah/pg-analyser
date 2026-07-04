import { describe, expect, test } from "bun:test";
import { ConfigError, loadConfig, loadConfigOptional } from "../src/config.ts";

const noCli = () => null;

describe("loadConfig", () => {
  test("resolves the access token from env", () => {
    const c = loadConfig({ SUPABASE_ACCESS_TOKEN: "sbp_x" } as NodeJS.ProcessEnv, noCli);
    expect(c).toEqual({ accessToken: "sbp_x", tokenSource: "env" });
  });

  test("falls back to the Supabase CLI token when env is unset", () => {
    const c = loadConfig({} as NodeJS.ProcessEnv, () => "sbp_from_cli");
    expect(c).toEqual({ accessToken: "sbp_from_cli", tokenSource: "cli" });
  });

  test("env token wins over the CLI token", () => {
    const c = loadConfig(
      { SUPABASE_ACCESS_TOKEN: "sbp_env" } as NodeJS.ProcessEnv,
      () => "sbp_cli",
    );
    expect(c.accessToken).toBe("sbp_env");
    expect(c.tokenSource).toBe("env");
  });

  test("throws when no token anywhere", () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv, noCli)).toThrow(ConfigError);
  });

  test("throws when the env token is empty and no CLI token", () => {
    expect(() => loadConfig({ SUPABASE_ACCESS_TOKEN: "" } as NodeJS.ProcessEnv, noCli)).toThrow(
      ConfigError,
    );
  });
});

describe("loadConfigOptional (no-PAT mode)", () => {
  test("returns the Config when a token is present", () => {
    expect(
      loadConfigOptional({ SUPABASE_ACCESS_TOKEN: "sbp_x" } as NodeJS.ProcessEnv, noCli),
    ).toEqual({ accessToken: "sbp_x", tokenSource: "env" });
  });

  test("returns null (does NOT throw) when no token anywhere", () => {
    expect(loadConfigOptional({} as NodeJS.ProcessEnv, noCli)).toBeNull();
  });
});
