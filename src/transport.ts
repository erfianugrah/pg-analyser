import type { TransportConfig } from "./config.ts";

/**
 * Transport abstracts WHERE requests go and HOW they authenticate, so the rest
 * of the tool speaks one logical API regardless of direct-vs-gatekeeper.
 *
 *  - mgmt(path):   Management API. `path` starts with /v1 or /v0.
 *  - metrics(ref): per-project Prometheus text.
 */
export interface Transport {
  readonly kind: "direct" | "gatekeeper";
  mgmt(path: string, init?: RequestInit): Promise<Response>;
  metrics(ref: string): Promise<Response>;
}

const SUPABASE_API = "https://api.supabase.com";

/** fetch with one retry on 429 / 5xx (exponential-ish backoff). */
async function fetchRetry(url: string, init: RequestInit, retries = 2): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, init);
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const waitMs =
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 400 * 2 ** attempt;
        await Bun.sleep(waitMs);
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await Bun.sleep(400 * 2 ** attempt);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

class DirectTransport implements Transport {
  readonly kind = "direct" as const;
  #serviceRoleCache = new Map<string, string>();

  constructor(private readonly accessToken: string) {}

  mgmt(path: string, init: RequestInit = {}): Promise<Response> {
    return fetchRetry(`${SUPABASE_API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    });
  }

  async metrics(ref: string): Promise<Response> {
    const key = await this.#serviceRole(ref);
    const auth = Buffer.from(`service_role:${key}`).toString("base64");
    return fetchRetry(`https://${ref}.supabase.co/customer/v1/privileged/metrics`, {
      headers: { Authorization: `Basic ${auth}` },
    });
  }

  async #serviceRole(ref: string): Promise<string> {
    const cached = this.#serviceRoleCache.get(ref);
    if (cached) return cached;
    const res = await this.mgmt(`/v1/projects/${ref}/api-keys`);
    if (!res.ok) throw new Error(`fetch api-keys failed: ${res.status} ${await res.text()}`);
    const keys = (await res.json()) as Array<{ name: string; api_key: string }>;
    const sr = keys.find((k) => k.name === "service_role")?.api_key;
    if (!sr) throw new Error(`no service_role key for project ${ref}`);
    this.#serviceRoleCache.set(ref, sr);
    return sr;
  }
}

class GatekeeperTransport implements Transport {
  readonly kind = "gatekeeper" as const;

  constructor(
    private readonly baseUrl: string,
    private readonly key: string,
  ) {}

  mgmt(path: string, init: RequestInit = {}): Promise<Response> {
    // Gatekeeper mounts the Management API under /supabase and swaps in the PAT.
    return fetchRetry(`${this.baseUrl}/supabase${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.key}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    });
  }

  metrics(ref: string): Promise<Response> {
    // Gatekeeper swaps in the per-project Basic secret upstream.
    return fetchRetry(`${this.baseUrl}/supabase/metrics/${ref}`, {
      headers: { Authorization: `Bearer ${this.key}` },
    });
  }
}

export function makeTransport(config: TransportConfig): Transport {
  return config.kind === "gatekeeper"
    ? new GatekeeperTransport(config.baseUrl, config.key)
    : new DirectTransport(config.accessToken);
}
