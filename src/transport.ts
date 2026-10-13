import type { Config } from "./config.ts";

/**
 * Transport abstracts HTTP access to the two Supabase surfaces so the rest of
 * the tool speaks one logical API (and tests can inject a fake).
 *
 *  - mgmt(path):   Management API. `path` starts with /v1 or /v0.
 *  - metrics(ref): per-project Prometheus text.
 */
export interface Transport {
  mgmt(path: string, init?: RequestInit): Promise<Response>;
  metrics(ref: string): Promise<Response>;
}

const SUPABASE_API = "https://api.supabase.com";

// Transient statuses worth retrying: rate-limit + gateway/proxy errors.
// Deliberately EXCLUDES 500 and Supabase's app-level codes (e.g. 544 "query
// failed / connection timeout") - retrying those just multiplies the wait on a
// paused or unreachable project.
const RETRYABLE = new Set([429, 502, 503, 504]);

// Largest Retry-After honoured, in ms. A longer one (a rate-limit window can
// run to minutes) falls back to the normal backoff: one more quick try, then
// the 429 goes back to the caller instead of stalling a whole --all sweep.
// A chosen value, not an upstream number.
export const MAX_RETRY_AFTER_MS = 30_000;

// Per-attempt request timeout, in ms. Bun's fetch documents no request timeout
// (https://bun.com/docs/runtime/networking/fetch.md shows AbortSignal.timeout);
// measured on 1.3.14, it gives up on a SILENT connection only after 300s, and
// the catch below used to retry that 3x - ~15 min per stalled call in a --all
// sweep (docs/plans/2026-10-13-transport-timeout-and-pgss-schema.md). 120s
// mirrors the superuser tier's statement_timeout default
// (PG_ANALYSER_STATEMENT_TIMEOUT): an API-proxied query gets no longer than a
// direct one. The signal stays armed while the caller reads the body, so it
// bounds headers AND body. A chosen value, not an upstream number.
export const DEFAULT_HTTP_TIMEOUT_MS = 120_000;

/** PG_ANALYSER_HTTP_TIMEOUT_MS: a non-negative integer (ms); `0` disables; else the default. */
export function httpTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PG_ANALYSER_HTTP_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_HTTP_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_HTTP_TIMEOUT_MS;
}

// One signal per attempt: the timeout, merged with any caller signal so the
// caller's own abort still works.
function attemptSignal(
  caller: AbortSignal | null | undefined,
  timeoutMs: number,
): AbortSignal | undefined {
  if (timeoutMs <= 0) return caller ?? undefined;
  const timeout = AbortSignal.timeout(timeoutMs);
  return caller ? AbortSignal.any([caller, timeout]) : timeout;
}

const backoffMs = (attempt: number): number => 400 * 2 ** attempt;

export type RetryOpts = {
  /** Extra attempts after the first (default 2). */
  retries?: number;
  /** Per-attempt timeout in ms; defaults to httpTimeoutMs() (env-overridable). 0 disables. */
  timeoutMs?: number;
  /** Injectable for tests; defaults to Bun.sleep. */
  sleep?: (ms: number) => Promise<unknown>;
};

/**
 * fetch with retries on transient statuses (Retry-After capped, else
 * exponential backoff) and a per-attempt timeout.
 */
export async function fetchRetry(
  url: string,
  init: RequestInit,
  opts: RetryOpts = {},
): Promise<Response> {
  const retries = opts.retries ?? 2;
  const timeoutMs = opts.timeoutMs ?? httpTimeoutMs();
  const sleep = opts.sleep ?? Bun.sleep;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const started = Date.now();
    try {
      const res = await fetch(url, { ...init, signal: attemptSignal(init.signal, timeoutMs) });
      if (RETRYABLE.has(res.status) && attempt < retries) {
        const retryAfterMs = Number(res.headers.get("retry-after")) * 1000;
        const waitMs =
          Number.isFinite(retryAfterMs) && retryAfterMs > 0 && retryAfterMs <= MAX_RETRY_AFTER_MS
            ? retryAfterMs
            : backoffMs(attempt);
        // Release the connection: an unread body keeps the socket busy until GC.
        await res.body?.cancel();
        await sleep(waitMs);
        continue;
      }
      return res;
    } catch (err) {
      // An abort is final. A timeout (ours, or Bun's own on a silent socket) is
      // not retried, for the same reason 544 is not: it only multiplies the
      // wait on an unreachable host. A caller's abort means stop.
      const name = (err as { name?: unknown } | null)?.name;
      if (name === "TimeoutError") {
        const limit = timeoutMs > 0 ? `${timeoutMs}ms` : "off";
        throw new Error(
          `request to ${url} timed out after ${Date.now() - started}ms (limit ${limit}, PG_ANALYSER_HTTP_TIMEOUT_MS)`,
          { cause: err },
        );
      }
      if (name === "AbortError") throw err;
      lastErr = err;
      if (attempt < retries) await sleep(backoffMs(attempt));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

class DirectTransport implements Transport {
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

export function makeTransport(config: Config): Transport {
  return new DirectTransport(config.accessToken);
}
