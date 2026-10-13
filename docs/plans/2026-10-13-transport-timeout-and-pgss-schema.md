# Transport timeout + quoted pgss schema - implementation plan

**Status (2026-10-13): SHIPPED 2026-10-13 (commits: see git log).** Covers
board cards `work-pg-analyser#3` (pgss schema, p1) and `work-pg-analyser#2`
(fetchRetry, p2). Dry-run verified against f62fd70 (see "Dry-run status" at
the end); executed on 8d35ef1 with the same sensor counts (1011 -> 1013 ->
1016 -> 1021 pass, 0 fail). Tasks 2 and 3 ship as one commit (they rewrite
the same `fetchRetry` block and test file).

> **For agentic workers:** Execute this plan inline, task by task, in the current session. Steps use checkbox (`- [ ]`) syntax for tracking. Per-task subagents (subagent-driven-development) only if the user asks for them.

**Goal:** stop an uppercase/mixed-case `pg_stat_statements` schema from
emptying every pgss plane, and stop one stalled or rate-limited HTTP call from
holding up a whole `full --all` sweep for many minutes.

**Architecture:** two independent, local fixes. `withPgssSchema()`
(`src/sql.ts`) inlines the resolved schema as a double-quoted identifier,
keeping its existing allowlist validation. `fetchRetry()` (`src/transport.ts`)
gains a per-attempt `AbortSignal.timeout`, an env override
(`PG_ANALYSER_HTTP_TIMEOUT_MS`, the repo's existing knob mechanism), a cap on
the honoured `Retry-After`, and cancels the body of every response it retries.
`fetchRetry` is exported with an options object (`retries`, `timeoutMs`,
`sleep`) so tests drive it with an injected sleep and a stubbed
`globalThis.fetch` (the existing `test/transport.test.ts` idiom) - no real
backoff sleeps, no network.

**Tech stack:** Bun 1.3.14 + TypeScript (strict, `noUncheckedIndexedAccess`),
biome 2 (lineWidth 100, import sorting enforced by `bun run lint`), `bun test`.
No new dependency.

**Commits:** each task ends with a commit step. In a Claude Code session the
git gate denies `git commit`: stage the listed files, write the message to the
scratchpad, and hand the user the one-liner instead.

**Sensors (run from the repo root; always `--no-env-file` - `.env` holds a
live DB URL):** `bun run typecheck`, `bun run lint`, `bun --no-env-file test`.
Baseline at f62fd70: typecheck exit 0, lint exit 0 (134 files), tests
1011 pass / 0 fail across 55 files.

---

## Verified against the repo on 2026-10-13

Read directly, not recalled:

- `withPgssSchema` (`src/sql.ts:32-46`) validates `^[a-zA-Z_][a-zA-Z0-9_]*$`
  and then inlines the schema bare: `${s}.pg_stat_statements`. The probe
  (`QUERIES.pgssSchema`, `src/sql.ts:124-128`) returns `pg_namespace.nspname`
  verbatim, so a schema created as `"Stats"` arrives as `Stats`, is inlined
  unquoted, and Postgres folds it to `stats` -> relation does not exist ->
  every pgss plane fails into a `safe()` collection note.
- Callers of `withPgssSchema`: ONE in source, `src/collect.ts:224`
  (`sqlQ = { ...QUERIES, ...withPgssSchema(schema) }`), plus the unit tests in
  `test/sql.test.ts:188-216`. No caller in `scripts/` or `acceptance/`
  (`rg -n withPgssSchema src scripts test acceptance`). collect.ts needs no
  code change; Task 1 adds a collect-level test so the wiring is covered.
- The replace target `extensions.pg_stat_statements` is a prefix of
  `extensions.pg_stat_statements_info` (`statsResetAge`), so quoting only the
  schema part (`"Stats".pg_stat_statements`) carries the `_info` view too.
- There is NO SQL identifier-quoting helper in `src/` (searched for `""`,
  `quote_ident`, `%I`, `quote`/`Ident` functions; the only `quote()` is
  `src/alerts.ts:665`, a YAML single-quote string helper). Task 1 uses the
  minimal inline form.
- `fetchRetry` (`src/transport.ts:23-43`) is module-private; its callers are
  `DirectTransport.mgmt` (`src/transport.ts:50-59`) and
  `DirectTransport.metrics` (`src/transport.ts:61-67`). `mgmt` is in turn
  called by `Management.#json` and `Management.readOnlySql`
  (`src/management.ts:10,135`, the PAT read-only SQL runner) and by
  `DirectTransport.#serviceRole`. No caller passes `init.signal` today
  (`rg -n "signal" src` hits only `src/sync.ts`, which uses its own fetch).
  Both callers keep calling `fetchRetry(url, init)` unchanged; the new
  defaults apply to them, and Task 3 tests both through `makeTransport`.
- Knob convention: every tunable is a `PG_ANALYSER_*` env var read at the use
  site with a numeric parse and fallback (`PG_ANALYSER_STATEMENT_TIMEOUT` /
  `PG_ANALYSER_LOCK_TIMEOUT` in `src/sqlrunner.ts:83-84`, `'0'` disables;
  `PG_ANALYSER_WAIT_SAMPLES` in `src/collect.ts:749-750`;
  `PG_ANALYSER_INCIDENT_SCAN_DAYS` in `src/collect.ts:448`). `Config`
  (`src/config.ts`) carries only the token. Task 3 follows the env-var
  pattern: `PG_ANALYSER_HTTP_TIMEOUT_MS`, `0` disables.
- Existing transport tests (`test/transport.test.ts`) stub
  `globalThis.fetch` via a local `mockFetch()` and restore it in `afterEach`;
  no test in the repo uses fake timers or `spyOn`. `bun test` also runs
  `acceptance/*.test.ts` (part of the 1011).

### Bun's fetch default timeout: undocumented, measured at 300 s

- Bun docs, "Fetching a URL with a timeout"
  (https://bun.com/docs/runtime/networking/fetch.md, read via the docs.erfi.io
  mirror 2026-10-13): the documented way to time out a fetch is
  `signal: AbortSignal.timeout(ms)`; the page states no default request
  timeout. Its only default timeout is `keepAlive.idleTimeout` (300 s), which
  governs how long an IDLE pooled connection is kept. The env-var reference
  (https://bun.com/docs/runtime/environment-variables.md) lists no fetch
  timeout variable (`BUN_CONFIG_MAX_HTTP_REQUESTS`, `BUN_CONFIG_VERBOSE_FETCH`
  only). `bun-types` 1.3.14 (`node_modules/bun-types/globals.d.ts`,
  `interface BunFetchRequestInit`) has no `timeout` field.
- Measured (loopback probe, Bun 1.3.14, 2026-10-13: a `node:net` server that
  accepts and never answers, `fetch()` with no signal): the request
  **rejected after 300 s with `TimeoutError: The operation timed out.`** So Bun
  does bound a SILENT connection at ~300 s, undocumented. Not measured: a
  server that trickles bytes (an idle-style limit would not fire there).
- Consequence for card #2: the "hang" is bounded, but badly. Today's catch
  branch retries any error, Bun's own `TimeoutError` included, so one silent
  endpoint costs 3 x 300 s + 1.2 s backoff (~15 min) per call before the plane
  fails, and a `--all` sweep pays that per affected project and plane.
- Same probe with signals: `AbortSignal.timeout(300)` rejects after ~304 ms
  with `name=TimeoutError`; `AbortSignal.any([caller, timeout])` rejects with
  `TimeoutError` when the timeout fires and `AbortError` when the caller
  aborts; all are `instanceof Error`. Task 3 keys on those names, and treats
  Bun's own 300 s `TimeoutError` the same way (final, not retried).

### Chosen values (not upstream numbers)

- `DEFAULT_HTTP_TIMEOUT_MS = 120_000`: mirrors the superuser tier's
  `statement_timeout` default (`PG_ANALYSER_STATEMENT_TIMEOUT`, 120s), so a
  query proxied through the Management API read-only endpoint is given no
  longer than the same query run directly. The signal stays armed while the
  caller reads the body, so it bounds headers AND body. Values above ~300 s
  only matter for a connection that keeps sending bytes; Bun's own limit ends
  a silent one first.
- `MAX_RETRY_AFTER_MS = 30_000`: a longer `Retry-After` falls back to the
  existing backoff (`400 * 2 ** attempt`), i.e. one more quick try and then the
  429 goes back to the caller, rather than sleeping minutes inside a sweep.
- A timed-out attempt is NOT retried, for the same reason 500/544 are not:
  retrying an unreachable host only multiplies the wait (worst case becomes one
  timeout instead of three). A caller's own abort is not retried either. The
  error message reports the measured elapsed time, so it stays true whichever
  limit (ours or Bun's) fired.

## File structure

- Modify `src/sql.ts:32-46` - `withPgssSchema` quotes the schema.
- Modify `src/transport.ts:17-43` - constants, `httpTimeoutMs`, `RetryOpts`,
  exported `fetchRetry`. `DirectTransport` (lines 45-84) is unchanged.
- Modify `test/sql.test.ts:199-211` - quoted expectations + mixed-case test.
- Modify `test/collect.test.ts` - import `QUERIES`; one wiring test.
- Modify `test/transport.test.ts` - import line; new describe blocks appended.
- Modify `AGENTS.md:234` (architecture line for transport.ts) and the README
  Troubleshooting table - document the knob.

---

### Task 1: quote the pg_stat_statements schema (card #3)

**Files:**
- Modify: `src/sql.ts:32-46`
- Test: `test/sql.test.ts:199-211`, `test/collect.test.ts:3` and after line 178

- [x] **Step 1: Write the failing tests**

In `test/sql.test.ts`, replace the whole test that starts at line 199
(`test("non-default schema rewrites exactly the pgss planes", () => {`)
through its closing `});` on line 211 with:

```ts
  test("non-default schema rewrites exactly the pgss planes, quoted", () => {
    const out = withPgssSchema("public");
    for (const k of PGSS_KEYS) {
      expect(out[k]).toBeDefined();
      expect(out[k]).toContain('"public".pg_stat_statements');
      expect(out[k]).not.toContain("extensions.pg_stat_statements");
    }
    // statsResetAge reads the _info view - the prefix replace must carry it
    expect(out.statsResetAge).toContain('"public".pg_stat_statements_info');
    // non-pgss planes are untouched
    expect("dbSize" in out).toBe(false);
    expect("locks" in out).toBe(false);
  });

  test("a mixed-case schema is inlined as a quoted identifier (no case-folding)", () => {
    const out = withPgssSchema("Stats");
    for (const k of PGSS_KEYS) {
      expect(out[k]).toContain('"Stats".pg_stat_statements');
      expect(out[k]).not.toMatch(/(^|[^"])Stats\.pg_stat_statements/);
    }
  });
```

Leave the following test (`rejects a non-identifier schema (inlined, no bind
params)`) as it is - the validation is kept.

In `test/collect.test.ts`, add this import directly after line 3
(`import { makeLogger } from "../src/log.ts";`):

```ts
import { QUERIES } from "../src/sql.ts";
```

Then insert this test directly after the test
`an injected SqlRunner runs the query set and sets sqlSource` (it ends with
`expect(t.calls.mgmt.some((p) => p.includes("query/read-only"))).toBe(false);`
then `  });` - original lines 177-178, so 178-179 once the import above is in):

```ts

  test("a mixed-case pg_stat_statements schema reaches the pgss planes quoted", async () => {
    const seen: string[] = [];
    const runner = {
      source: "superuser" as const,
      run: async (q: string) => {
        seen.push(q);
        return q === QUERIES.pgssSchema ? [{ schema: "Stats" }] : [];
      },
    };
    const t = fakeTransport({ onMgmt: fullRoutes(), onMetrics: okMetrics });
    await collect("ref", t, "0.0.0-test", { syncCheck: false, sqlRunner: runner });
    // every plane that reads the extension's views went out schema-qualified AND quoted
    const pgss = seen.filter((q) => /\.pg_stat_statements/.test(q));
    expect(pgss.length).toBeGreaterThan(0);
    for (const q of pgss) expect(q).toContain('"Stats".pg_stat_statements');
  });
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `bun --no-env-file test test/sql.test.ts test/collect.test.ts`
Expected: 3 fail - `non-default schema rewrites exactly the pgss planes,
quoted`, `a mixed-case schema is inlined as a quoted identifier`, and `a
mixed-case pg_stat_statements schema reaches the pgss planes quoted` (each
`toContain` reports the unquoted `public.` / `Stats.` text). Everything else
in both files passes.

- [x] **Step 3: Implement**

In `src/sql.ts`, replace lines 32-46 (the comment block above
`withPgssSchema` through the function's closing `}`) with:

```ts
// Rewrite the pgss planes for a resolved extension schema. The schema comes
// from pg_extension on the target DB - validate it as a plain identifier
// before inlining (the SQL here takes no bind params); anything else falls
// back to the hosted default. Inline it QUOTED: the probe returns nspname
// verbatim, and an unquoted `Stats.pg_stat_statements` case-folds to `stats`
// and fails every pgss plane into a collection note.
export function withPgssSchema(
  schema: string | undefined,
): Partial<Record<(typeof PGSS_KEYS)[number], string>> {
  const s = schema && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema) ? schema : PGSS_DEFAULT_SCHEMA;
  if (s === PGSS_DEFAULT_SCHEMA) return {};
  const ident = `"${s.replaceAll('"', '""')}"`;
  const out: Partial<Record<(typeof PGSS_KEYS)[number], string>> = {};
  for (const k of PGSS_KEYS) {
    out[k] = QUERIES[k].replaceAll("extensions.pg_stat_statements", `${ident}.pg_stat_statements`);
  }
  return out;
}
```

(The `""` doubling cannot fire while the allowlist regex stands; it keeps the
quoting correct if that regex is ever widened.)

- [x] **Step 4: Run the tests to verify they pass, then the full sensors**

Run: `bun --no-env-file test test/sql.test.ts test/collect.test.ts`
Expected: all pass, 0 fail.

Run: `bun run typecheck` - Expected: exit 0, no output after the `tsc --noEmit` line.
Run: `bun run lint` - Expected: exit 0, `Checked 134 files ... No fixes applied.`
Run: `bun --no-env-file test` - Expected: `1013 pass`, `0 fail`.

- [x] **Step 5: Commit**

```bash
git add src/sql.ts test/sql.test.ts test/collect.test.ts
git commit -m "fix(sql): quote the resolved pg_stat_statements schema as an identifier"
```

Executed 2026-10-13 on 8d35ef1: red = 125 pass / 3 fail (the 3 new tests,
each `toContain` receiving unquoted `public.` / `Stats.`); green = 128 pass /
0 fail; typecheck exit 0, lint exit 0 (134 files), full suite 1013 pass /
0 fail. Deviation: the git gate denies agent commits, so the commit is a
step in the scratchpad commit script (run by the user), not made here.

---

### Task 2: cap Retry-After and drain retried responses (card #2, part 1)

**Files:**
- Modify: `src/transport.ts:17-43`
- Test: `test/transport.test.ts:2` and append at end of file

- [x] **Step 1: Write the failing tests**

In `test/transport.test.ts`, replace line 2:

```ts
import { makeTransport } from "../src/transport.ts";
```

with:

```ts
import { fetchRetry, MAX_RETRY_AFTER_MS, makeTransport } from "../src/transport.ts";
```

Append to the end of `test/transport.test.ts`:

```ts

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
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `bun --no-env-file test test/transport.test.ts`
Expected: FAIL at load - `SyntaxError: Export named 'fetchRetry' not found in
module '.../src/transport.ts'.` reported as `# Unhandled error between tests`,
then `0 pass`, `1 fail`, `1 error`; `fetchRetry` is not exported yet.

- [x] **Step 3: Implement**

In `src/transport.ts`, replace lines 17-43 (from the `// Transient statuses
worth retrying` comment through the closing `}` of `fetchRetry`) with:

```ts
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

const backoffMs = (attempt: number): number => 400 * 2 ** attempt;

export type RetryOpts = {
  /** Extra attempts after the first (default 2). */
  retries?: number;
  /** Injectable for tests; defaults to Bun.sleep. */
  sleep?: (ms: number) => Promise<unknown>;
};

/** fetch with retries on transient statuses (Retry-After capped, else exponential backoff). */
export async function fetchRetry(
  url: string,
  init: RequestInit,
  opts: RetryOpts = {},
): Promise<Response> {
  const retries = opts.retries ?? 2;
  const sleep = opts.sleep ?? Bun.sleep;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, init);
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
      lastErr = err;
      if (attempt < retries) await sleep(backoffMs(attempt));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
```

- [x] **Step 4: Run the tests to verify they pass, then the full sensors**

Run: `bun --no-env-file test test/transport.test.ts`
Expected: `8 pass`, `0 fail`.

Run: `bun run typecheck` - Expected: exit 0.
Run: `bun run lint` - Expected: exit 0, `No fixes applied.`
Run: `bun --no-env-file test` - Expected: `1016 pass`, `0 fail`.

- [x] **Step 5: Commit**

```bash
git add src/transport.ts test/transport.test.ts
git commit -m "fix(transport): cap Retry-After and cancel the body of retried responses"
```

Executed 2026-10-13: red = load error `SyntaxError: Export named 'fetchRetry'
not found in module '.../src/transport.ts'.` under `# Unhandled error between
tests`, 0 pass / 1 fail / 1 error; green = transport file 8 pass / 0 fail;
typecheck exit 0, lint exit 0 (134 files), full suite 1016 pass / 0 fail.
Deviation: commit deferred to the scratchpad commit script (git gate), and
grouped with Task 3 into ONE commit because both tasks rewrite the same
`fetchRetry` block in `src/transport.ts` and the same `test/transport.test.ts`
import line - per-file staging cannot separate them.

---

### Task 3: per-attempt request timeout + PG_ANALYSER_HTTP_TIMEOUT_MS (card #2, part 2)

**Files:**
- Modify: `src/transport.ts` (the block written in Task 2)
- Test: `test/transport.test.ts:2` and append at end of file

- [x] **Step 1: Write the failing tests**

In `test/transport.test.ts`, replace line 2 (the import written in Task 2) with:

```ts
import {
  DEFAULT_HTTP_TIMEOUT_MS,
  fetchRetry,
  httpTimeoutMs,
  MAX_RETRY_AFTER_MS,
  makeTransport,
} from "../src/transport.ts";
```

Append to the end of `test/transport.test.ts`:

```ts

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
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `bun --no-env-file test test/transport.test.ts`
Expected: FAIL at load - `SyntaxError: Export named 'httpTimeoutMs' not found
in module '.../src/transport.ts'.` reported as `# Unhandled error between
tests`, then `0 pass`, `1 fail`, `1 error` (`DEFAULT_HTTP_TIMEOUT_MS` is
missing too; Bun names only one).

- [x] **Step 3: Implement**

In `src/transport.ts`, replace the block from
`export const MAX_RETRY_AFTER_MS = 30_000;` through the closing `}` of
`fetchRetry` (written in Task 2) with:

```ts
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
```

`DirectTransport.mgmt` and `DirectTransport.metrics` keep calling
`fetchRetry(url, init)`; they pick up the env-driven default with no change.

- [x] **Step 4: Run the tests to verify they pass, then the full sensors**

Run: `bun --no-env-file test test/transport.test.ts`
Expected: `13 pass`, `0 fail`.

Run: `bun run typecheck` - Expected: exit 0.
Run: `bun run lint` - Expected: exit 0, `No fixes applied.`
Run: `bun --no-env-file test` - Expected: `1021 pass`, `0 fail`.

- [x] **Step 5: Commit**

```bash
git add src/transport.ts test/transport.test.ts
git commit -m "fix(transport): time out each HTTP attempt (PG_ANALYSER_HTTP_TIMEOUT_MS)"
```

Executed 2026-10-13: red = load error `SyntaxError: Export named
'httpTimeoutMs' not found in module '.../src/transport.ts'.`, 0 pass / 1 fail
/ 1 error; green = transport file 13 pass / 0 fail; typecheck exit 0, lint
exit 0 (134 files), full suite 1021 pass / 0 fail. Deviation: committed
together with Task 2 as one commit (same `fetchRetry` block, same test file);
the commit subject is this task's, the body names both changes.

---

### Task 4: document the knob

**Files:**
- Modify: `AGENTS.md:234`
- Modify: `README.md` (Troubleshooting table, after the row starting `| A sweep is too quiet`)

- [x] **Step 1: Make the change**

In `AGENTS.md`, replace line 234:

```
  transport.ts   Transport interface + DirectTransport (auth + retry)
```

with:

```
  transport.ts   Transport interface + DirectTransport (auth + retry). fetchRetry
                 times out EACH attempt via AbortSignal.timeout:
                 PG_ANALYSER_HTTP_TIMEOUT_MS, default 120000, 0 disables (Bun's
                 fetch documents no timeout; measured 1.3.14: a silent socket
                 rejects after 300s). A timeout is not retried. Retry-After is
                 honoured up to 30s (longer -> normal backoff), and a retried
                 response's body is cancelled so the socket is released.
```

In `README.md`, insert this row directly after the Troubleshooting row that
starts `| A sweep is too quiet / you want per-plane detail`:

```
| A sweep stalls on one project's API / metrics call   | Each HTTP attempt times out after 120s (`request to ... timed out after ...ms`, recorded as a collection note). Tune with `PG_ANALYSER_HTTP_TIMEOUT_MS` (ms; `0` disables). |
```

- [x] **Step 2: Verify**

Run: `rg -c "PG_ANALYSER_HTTP_TIMEOUT_MS" AGENTS.md README.md src/transport.ts`
Expected (in any order): `AGENTS.md:1`, `README.md:1`, `src/transport.ts:3`
(the `httpTimeoutMs` doc comment, the `env.` read, the timeout error message).

Run: `bun run lint` - Expected: exit 0 (biome ignores `.md`; this guards a
stray edit elsewhere).

- [x] **Step 3: Commit**

```bash
git add AGENTS.md README.md
git commit -m "docs: document PG_ANALYSER_HTTP_TIMEOUT_MS and the fetchRetry bounds"
```

Executed 2026-10-13: `rg -c` printed `README.md:1`, `src/transport.ts:3`,
`AGENTS.md:1`; lint exit 0 (134 files). Deviation: commit deferred to the
scratchpad commit script (git gate).

---

### Task 5: close out

- [x] **Step 1: Mark this plan shipped** - change the status line at the top to
`**Status (<ship date>): SHIPPED.**` followed by the commit shas of Tasks 1-4,
and tick the checkboxes.

- [x] **Step 2: Move the cards**

> Done 2026-10-13 after the push: #3 -> review on 335ece0, #2 -> review on
> 711dc46 + 9280c65.

Run: `vkctl comment work-pg-analyser#2 "Shipped <sha>: ... Verify: bun --no-env-file test"`
(same for #3), then `vkctl mv work-pg-analyser#3 work-pg-analyser#2 review`
Expected: both cards reported moved to `review` (queued if no token is
available; `vkctl flush` replays the queue). Agents stop at In Review; only
the user moves a card to Done.

- [x] **Step 3: Commit**

```bash
git add docs/plans/2026-10-13-transport-timeout-and-pgss-schema.md
git commit -m "docs(plans): mark transport-timeout + pgss-schema plan shipped"
```

Executed 2026-10-13. Deviations: Step 1 - the status banner reads "commits:
see git log" because the shas do not exist until the user runs the commit
script. Step 2 - NOT done in this session (left unticked): the card move is
done by the coordinating session after the user pushes. Step 3 - deferred to
the scratchpad commit script, which commits this file last.

---

## Self-review

- Card #3: quote the schema, keep validation, cover every caller -> Task 1
  (`withPgssSchema` + the single caller `src/collect.ts:224` via a collect-level
  test; the `rejects a non-identifier schema` test stays).
- Card #2: per-attempt `AbortSignal.timeout` with a default and an
  existing-style override -> Task 3 (`PG_ANALYSER_HTTP_TIMEOUT_MS`, env pattern
  of `PG_ANALYSER_STATEMENT_TIMEOUT`); Retry-After cap with backoff fallback and
  `res.body?.cancel()` on retried responses -> Task 2; both callers
  (`DirectTransport.mgmt`, `.metrics`) -> Task 3 test through `makeTransport`.
  Bun default-timeout finding -> "Bun's fetch default timeout" section.
- No placeholders; every code step shows the full replacement block.
- Names are consistent across tasks: `fetchRetry`, `RetryOpts`
  (`retries`/`timeoutMs`/`sleep`), `MAX_RETRY_AFTER_MS`,
  `DEFAULT_HTTP_TIMEOUT_MS`, `httpTimeoutMs`, `attemptSignal`, `backoffMs`,
  test helpers `recordSleeps`, `stallFetch`, `API_URL`.

## Dry-run status

Dry-run 2026-10-13 on a scratch copy of f62fd70 (rsync without `.git` /
`node_modules`, `node_modules` symlinked back; Bun 1.3.14). Every code block
was extracted from this file and applied by script (no retyping), Tasks 1-4
in order, sensors after each task:

| Point | typecheck | lint | `bun --no-env-file test` |
|---|---|---|---|
| Baseline | exit 0 | exit 0 (134 files) | 1011 pass / 0 fail (55 files) |
| Task 1 red | - | - | sql+collect files: 125 pass / 3 fail (the 3 new tests) |
| After Task 1 | exit 0 | exit 0 | 1013 pass / 0 fail |
| Task 2 red | - | - | transport file: load error, `Export named 'fetchRetry'` |
| After Task 2 | exit 0 | exit 0 | 1016 pass / 0 fail |
| Task 3 red | - | - | transport file: load error, `Export named 'httpTimeoutMs'` |
| After Task 3 | exit 0 | exit 0 | 1021 pass / 0 fail |
| After Task 4 | exit 0 | exit 0 | 1021 pass / 0 fail (55 files) |

Mutation check (fix removed, test confirmed red, fix restored), one per new
behaviour: unquoted `ident` -> the 3 Task 1 tests fail; Retry-After cap
removed -> "above the cap" fails; `<=` -> `<` at the cap -> "at the cap"
fails; `res.body?.cancel()` removed -> "cancels the body" fails; no signal
passed -> "aborts a stalled attempt" + "DirectTransport ... signal" fail;
TimeoutError retried -> "aborts a stalled attempt" fails; AbortError retried
-> "caller's abort" fails; `AbortSignal.any` dropped -> "caller's abort"
fails; env value unvalidated -> `httpTimeoutMs` fails; `0` not disabling ->
"timeoutMs 0" fails. Task 5 (board move, status banner) was not dry-run: it
writes to the live board.

Plan defects found and fixed during the dry run, then the whole plan replayed
clean from a reset copy:

1. Task 1 collect-test anchor was off by one (the `});` is original line 178,
   not 177).
2. Task 2/3 red-step output: bun reports `0 pass / 1 fail / 1 error` under
   `# Unhandled error between tests`, not `0 pass / 1 error`.
3. Task 3 red step: bun names `httpTimeoutMs` as the missing export, not
   `DEFAULT_HTTP_TIMEOUT_MS`.
4. Task 3 `stallFetch` originally never settled when called without a signal;
   the no-signal mutant then HUNG the suite (bun's 5 s per-test timeout did not
   fire; killed after >200 s) instead of failing. It now rejects with
   `fetch called without a signal`.
5. Task 4 verify count: `src/transport.ts` has 3 matching lines, not 4, and
   `rg -c` prints the files in no fixed order.
6. Before writing Task 3, the loopback probe overturned the card's premise
   (Bun does give up on a silent socket at 300 s, undocumented); the timeout
   message reports measured elapsed time so it stays true whichever limit
   fires.
