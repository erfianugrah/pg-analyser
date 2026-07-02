import type { Transport } from "../src/transport.ts";

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function textResponse(body: string, status = 200): Response {
  return new Response(body, { status });
}

export type MgmtHandler = (path: string, init?: RequestInit) => Response;
export type MetricsHandler = (ref: string) => Response;

/** A Transport whose behaviour is fully controlled by handlers, recording calls. */
export function fakeTransport(opts: {
  kind?: "direct" | "gatekeeper";
  onMgmt: MgmtHandler;
  onMetrics?: MetricsHandler;
}): Transport & { calls: { mgmt: string[]; metrics: string[] } } {
  const calls = { mgmt: [] as string[], metrics: [] as string[] };
  return {
    kind: opts.kind ?? "direct",
    calls,
    async mgmt(path, init) {
      calls.mgmt.push(path);
      return opts.onMgmt(path, init);
    },
    async metrics(ref) {
      calls.metrics.push(ref);
      if (!opts.onMetrics) return textResponse("metrics unavailable", 404);
      return opts.onMetrics(ref);
    },
  };
}
