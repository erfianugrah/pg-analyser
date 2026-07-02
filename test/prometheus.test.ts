import { afterEach, describe, expect, test } from "bun:test";
import { fetchTrends } from "../src/prometheus.ts";
import { jsonResponse } from "./helpers.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function rangeResp(values: Array<[number, string]>) {
  return jsonResponse({ status: "success", data: { result: values.length ? [{ values }] : [] } });
}

describe("fetchTrends", () => {
  test("parses query_range into TrendSeries, skips empty panels", async () => {
    const calls: string[] = [];
    globalThis.fetch = ((url: string) => {
      calls.push(url);
      // give data to the CPU panel, nothing to the rest
      if (url.includes("node_load1")) {
        return Promise.resolve(
          rangeResp([
            [1000, "0.5"],
            [1300, "0.7"],
          ]),
        );
      }
      return Promise.resolve(rangeResp([]));
    }) as unknown as typeof fetch;

    const trends = await fetchTrends("http://prom:9090");
    expect(trends).toHaveLength(1);
    expect(trends[0]?.title).toBe("CPU load (1m)");
    expect(trends[0]?.points).toEqual([
      { t: 1000, v: 0.5 },
      { t: 1300, v: 0.7 },
    ]);
    // range query params present
    expect(calls[0]).toContain("/api/v1/query_range?query=");
    expect(calls[0]).toContain("&step=");
  });

  test("throws on non-2xx (captured upstream by collect's safe wrapper)", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response("boom", { status: 502 }))) as unknown as typeof fetch;
    await expect(fetchTrends("http://prom:9090")).rejects.toThrow(/502/);
  });

  test("drops non-finite values", async () => {
    globalThis.fetch = ((url: string) =>
      Promise.resolve(
        url.includes("node_load1")
          ? rangeResp([
              [1, "NaN"],
              [2, "1.5"],
            ])
          : rangeResp([]),
      )) as unknown as typeof fetch;
    const trends = await fetchTrends("http://prom:9090");
    expect(trends[0]?.points).toEqual([{ t: 2, v: 1.5 }]);
  });
});
