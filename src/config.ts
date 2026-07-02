import { z } from "zod";

/**
 * Environment configuration. sbperf authenticates to the Supabase Management
 * API (and the per-project metrics endpoint, via an auto-fetched service_role
 * key) with a Personal Access Token.
 */
const EnvSchema = z.object({
  SUPABASE_ACCESS_TOKEN: z.string().min(1).optional(),
});

export type Config = {
  accessToken: string;
};

/** Resolve config from the process environment. Throws if the PAT is missing. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(`invalid environment:\n${z.prettifyError(parsed.error)}`);
  }
  if (!parsed.data.SUPABASE_ACCESS_TOKEN) {
    throw new ConfigError(
      "SUPABASE_ACCESS_TOKEN is required (get one at https://supabase.com/dashboard/account/tokens)",
    );
  }
  return { accessToken: parsed.data.SUPABASE_ACCESS_TOKEN };
}

export class ConfigError extends Error {
  override name = "ConfigError";
}
