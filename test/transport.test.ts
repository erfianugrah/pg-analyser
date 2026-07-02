import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeTransport } from "../src/transport.ts";
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
    const t = makeTransport({ accessToken: "sbp_secret" });
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
    const t = makeTransport({ accessToken: "sbp_x" });
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
    const t = makeTransport({ accessToken: "sbp_x" });
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
    const t = makeTransport({ accessToken: "sbp_x" });
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
    const t = makeTransport({ accessToken: "sbp_x" });
    await t.mgmt("/v1/x");
    expect(n).toBe(1);
  });
});
