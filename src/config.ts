import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

/**
 * Environment configuration. sbperf authenticates to the Supabase Management
 * API (and the per-project metrics endpoint, via an auto-fetched service_role
 * key) with a Personal Access Token.
 *
 * Token resolution order:
 *   1. SUPABASE_ACCESS_TOKEN env
 *   2. the Supabase CLI's stored token (~/.supabase/access-token) - so a user
 *      who has run `supabase login` needs no extra setup.
 */
const EnvSchema = z.object({
  SUPABASE_ACCESS_TOKEN: z.string().min(1).optional(),
});

export type TokenSource = "env" | "cli";
export type Config = {
  accessToken: string;
  tokenSource: TokenSource;
};

/** Path the Supabase CLI writes its access token to (file-backed auth). */
export const CLI_TOKEN_PATH = join(homedir(), ".supabase", "access-token");

/** Read the Supabase CLI's stored access token, or null if absent/unreadable. */
export function readCliToken(path: string = CLI_TOKEN_PATH): string | null {
  try {
    const t = readFileSync(path, "utf8").trim();
    return t.length ? t : null;
  } catch {
    return null;
  }
}

/**
 * Resolve config from the environment, falling back to the Supabase CLI token.
 * `cliToken` is injectable so tests stay hermetic (the dev box has a real CLI
 * token that would otherwise leak into the "missing token" case).
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  cliToken: () => string | null = readCliToken,
): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(`invalid environment:\n${z.prettifyError(parsed.error)}`);
  }
  if (parsed.data.SUPABASE_ACCESS_TOKEN) {
    return { accessToken: parsed.data.SUPABASE_ACCESS_TOKEN, tokenSource: "env" };
  }
  const cli = cliToken();
  if (cli) {
    return { accessToken: cli, tokenSource: "cli" };
  }
  throw new ConfigError(
    "no access token. Set SUPABASE_ACCESS_TOKEN " +
      "(https://supabase.com/dashboard/account/tokens), or run `supabase login` " +
      `so sbperf can read it from ${CLI_TOKEN_PATH}`,
  );
}

/**
 * Like loadConfig but returns null instead of throwing when no token is found.
 * Enables no-PAT mode: sbperf can run against a superuser --db-url (+ optional
 * Grafana trends) with no Supabase Management API access at all. A malformed
 * env (not merely absent) still throws.
 */
export function loadConfigOptional(
  env: NodeJS.ProcessEnv = process.env,
  cliToken: () => string | null = readCliToken,
): Config | null {
  try {
    return loadConfig(env, cliToken);
  } catch (err) {
    if (err instanceof ConfigError) return null;
    throw err;
  }
}

export class ConfigError extends Error {
  override name = "ConfigError";
}
