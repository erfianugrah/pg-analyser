import { z } from "zod";

/**
 * Environment + transport configuration.
 *
 * Two transports:
 *  - direct:     hits api.supabase.com + <ref>.supabase.co metrics directly,
 *                using a Personal Access Token (+ auto-fetched service_role key).
 *  - gatekeeper: proxies through a Gatekeeper IAM gateway. A single narrow key
 *                replaces both the PAT and the service_role secret; Gatekeeper
 *                swaps the real upstream credentials in server-side.
 */
export const TransportKind = z.enum(["direct", "gatekeeper"]);
export type TransportKind = z.infer<typeof TransportKind>;

const EnvSchema = z.object({
  SUPABASE_ACCESS_TOKEN: z.string().min(1).optional(),
  GATEKEEPER_URL: z.string().url().optional(),
  GATEKEEPER_KEY: z.string().min(1).optional(),
  SBPERF_TRANSPORT: TransportKind.optional(),
});

export type DirectConfig = {
  kind: "direct";
  accessToken: string;
};

export type GatekeeperConfig = {
  kind: "gatekeeper";
  baseUrl: string; // e.g. https://gate.example.com (no trailing slash)
  key: string;
};

export type TransportConfig = DirectConfig | GatekeeperConfig;

/** Resolve transport config from the process environment. Throws on ambiguity. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): TransportConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(`invalid environment:\n${z.prettifyError(parsed.error)}`);
  }
  const e = parsed.data;

  const kind: TransportKind = e.SBPERF_TRANSPORT ?? (e.GATEKEEPER_URL ? "gatekeeper" : "direct");

  if (kind === "gatekeeper") {
    if (!e.GATEKEEPER_URL || !e.GATEKEEPER_KEY) {
      throw new ConfigError("gatekeeper transport requires GATEKEEPER_URL and GATEKEEPER_KEY");
    }
    return {
      kind: "gatekeeper",
      baseUrl: e.GATEKEEPER_URL.replace(/\/+$/, ""),
      key: e.GATEKEEPER_KEY,
    };
  }

  if (!e.SUPABASE_ACCESS_TOKEN) {
    throw new ConfigError(
      "direct transport requires SUPABASE_ACCESS_TOKEN (or set GATEKEEPER_URL for gatekeeper mode)",
    );
  }
  return { kind: "direct", accessToken: e.SUPABASE_ACCESS_TOKEN };
}

export class ConfigError extends Error {
  override name = "ConfigError";
}
