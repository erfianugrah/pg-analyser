import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_HTTP_TIMEOUT_MS,
  fetchRetry,
  httpTimeoutMs,
  MAX_RETRY_AFTER_MS,
  makeTransport,
} from "../src/transport.ts";
import { jsonResponse, textResponse } from "./helpers.ts";

type Call = { url: string; init?: RequestInit };
let calls: Call[];
const realFetch = globalThis.fetch;

function mockFetch(handler: (url: string, init?: RequestInit) => Response) {
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    return Promise.resolve(handler(url, init));
  }) as typeof fetch;
}

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("DirectTransport", () => {
  test("mgmt hits api.supabase.com with Bearer PAT", async () => {
    mockFetch(() => jsonResponse({ ok: true }));
    const t = makeTransport({ accessToken: "sbp_secret", tokenSource: "env" });
    await t.mgmt("/v1/projects/ref");
    expect(calls[0]?.url).toBe("https://api.supabase.com/v1/projects/ref");
    expect((calls[0]?.init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer sbp_secret",
    );
  });

  test("metrics fetches service_role once (cached) then Basic-auths", async () => {
    mockFetch((url) => {
      if (url.includes("/api-keys")) {
        return jsonResponse([{ name: "service_role", api_key: "srk_123" }]);
      }
      return textResponse("# prometheus");
    });
    const t = makeTransport({ accessToken: "sbp_x", tokenSource: "env" });
    await t.metrics("myref");
    await t.metrics("myref");

    const apiKeyCalls = calls.filter((c) => c.url.includes("/api-keys"));
    expect(apiKeyCalls).toHaveLength(1); // cached across the two metrics calls

    const metricsCall = calls.find((c) => c.url.includes("/customer/v1/privileged/metrics"));
    expect(metricsCall?.url).toBe("https://myref.supabase.co/customer/v1/privileged/metrics");
    const auth = (metricsCall?.init?.headers as Record<string, string>).Authorization;
    expect(auth).toBe(`Basic ${Buffer.from("service_role:srk_123").toString("base64")}`);
  });
});

describe("fetchRetry", () => {
  test("retries on 429 then succeeds", async () => {
    let n = 0;
    mockFetch(() => {
      n++;
      return n === 1 ? textResponse("rate limited", 429) : jsonResponse({ ok: true });
    });
    const t = makeTransport({ accessToken: "sbp_x", tokenSource: "env" });
    const res = await t.mgmt("/v1/x");
    expect(res.status).toBe(200);
    expect(n).toBe(2);
  });

  test("does NOT retry on 544 (Supabase app-level failure) - fails fast", async () => {
    let n = 0;
    mockFetch(() => {
      n++;
      return textResponse('{"message":"connection timeout"}', 544);
    });
    const t = makeTransport({ accessToken: "sbp_x", tokenSource: "env" });
    const res = await t.mgmt("/v1/x");
    expect(res.status).toBe(544);
    expect(n).toBe(1); // single attempt, no retry storm on a paused project
  });

  test("does NOT retry on 500", async () => {
    let n = 0;
    mockFetch(() => {
      n++;
      return textResponse("boom", 500);
    });
    const t = makeTransport({ accessToken: "sbp_x", tokenSource: "env" });
    await t.mgmt("/v1/x");
    expect(n).toBe(1);
  });
});

const API_URL = "https://api.supabase.com/v1/x";

/** An injected sleep that records the requested waits instead of sleeping. */
function recordSleeps() {
  const waits: number[] = [];
  const sleep = async (ms: number) => {
    waits.push(ms);
  };
  return { waits, sleep };
}

describe("fetchRetry Retry-After cap and body drain", () => {
  test("a Retry-After above the cap falls back to the backoff instead of sleeping it", async () => {
    let n = 0;
    mockFetch(() => {
      n++;
      return n === 1
        ? new Response("slow down", { status: 429, headers: { "retry-after": "3600" } })
        : jsonResponse({ ok: true });
    });
    const { waits, sleep } = recordSleeps();
    const res = await fetchRetry(API_URL, {}, { sleep });
    expect(res.status).toBe(200);
    expect(waits).toEqual([400]); // first backoff step, not 3_600_000
  });

  test("a Retry-After at the cap is honoured", async () => {
    let n = 0;
    mockFetch(() => {
      n++;
      return n === 1
        ? new Response("busy", {
            status: 503,
            headers: { "retry-after": String(MAX_RETRY_AFTER_MS / 1000) },
          })
        : jsonResponse({ ok: true });
    });
    const { waits, sleep } = recordSleeps();
    await fetchRetry(API_URL, {}, { sleep });
    expect(waits).toEqual([MAX_RETRY_AFTER_MS]);
  });

  test("cancels the body of a response it is about to retry", async () => {
    let cancelled = false;
    let n = 0;
    mockFetch(() => {
      n++;
      if (n > 1) return jsonResponse({ ok: true });
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode("bad gateway"));
        },
        cancel() {
          cancelled = true;
        },
      });
      return new Response(body, { status: 502 });
    });
    const { sleep } = recordSleeps();
    const res = await fetchRetry(API_URL, {}, { sleep });
    expect(res.status).toBe(200);
    expect(cancelled).toBe(true);
  });
});

/** A fetch that never answers: it settles only when its signal aborts. */
function stallFetch() {
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Promise<Response>((_, reject) => {
      const s = init?.signal;
      if (!s) {
        // A real stalled request with no signal hangs; never-settling here
        // would hang the suite (bun's per-test timeout did not fire in the
        // dry run), so a regression fails loudly instead.
        reject(new Error("fetch called without a signal"));
      } else if (s.aborted) {
        reject(s.reason);
      } else {
        s.addEventListener("abort", () => reject(s.reason), { once: true });
      }
    });
  }) as typeof fetch;
}

describe("fetchRetry per-attempt timeout", () => {
  // AbortSignal.timeout runs on a real timer; 20 ms keeps the test fast.
  test("aborts a stalled attempt after timeoutMs and does not retry it", async () => {
    stallFetch();
    const { waits, sleep } = recordSleeps();
    await expect(fetchRetry(API_URL, {}, { timeoutMs: 20, sleep })).rejects.toThrow(
      /timed out after \d+ms \(limit 20ms/,
    );
    expect(calls).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  test("a caller's abort is honoured, not retried", async () => {
    stallFetch();
    const ctrl = new AbortController();
    ctrl.abort();
    const { waits, sleep } = recordSleeps();
    await expect(
      fetchRetry(API_URL, { signal: ctrl.signal }, { timeoutMs: 1_000, sleep }),
    ).rejects.toThrow(/abort/i);
    expect(calls).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  test("timeoutMs 0 sends no signal (timeout disabled)", async () => {
    mockFetch(() => jsonResponse({ ok: true }));
    await fetchRetry(API_URL, {}, { timeoutMs: 0 });
    expect(calls[0]?.init?.signal).toBeUndefined();
  });

  test("DirectTransport mgmt and metrics both send a timeout signal by default", async () => {
    mockFetch((url) =>
      url.includes("/api-keys")
        ? jsonResponse([{ name: "service_role", api_key: "srk_1" }])
        : textResponse("# prometheus"),
    );
    const t = makeTransport({ accessToken: "sbp_x", tokenSource: "env" });
    await t.mgmt("/v1/projects/ref");
    await t.metrics("ref");
    expect(calls).toHaveLength(3); // mgmt, api-keys, metrics
    for (const c of calls) expect(c.init?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("httpTimeoutMs (PG_ANALYSER_HTTP_TIMEOUT_MS)", () => {
  test("defaults to 120s, accepts a non-negative integer, 0 disables, rejects junk", () => {
    expect(DEFAULT_HTTP_TIMEOUT_MS).toBe(120_000);
    expect(httpTimeoutMs({})).toBe(DEFAULT_HTTP_TIMEOUT_MS);
    expect(httpTimeoutMs({ PG_ANALYSER_HTTP_TIMEOUT_MS: "5000" })).toBe(5000);
    expect(httpTimeoutMs({ PG_ANALYSER_HTTP_TIMEOUT_MS: "0" })).toBe(0);
    for (const junk of ["", " ", "abc", "-1", "1.5", "30s"]) {
      expect(httpTimeoutMs({ PG_ANALYSER_HTTP_TIMEOUT_MS: junk })).toBe(DEFAULT_HTTP_TIMEOUT_MS);
    }
  });
});
