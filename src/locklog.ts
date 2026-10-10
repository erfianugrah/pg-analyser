/**
 * Server-log lock-wave parser (Check 1 of the lock-contention plan). Pure, no
 * IO: turns a chunk of Postgres server-log text + a coverage window into a
 * bounded, privacy-safe summary. A lock-queue cascade shows as a burst of
 * "still waiting for ...Lock" lines and timeout-cancellation ERRORs; the log is
 * the only on-box record of it (it is invisible to any point-in-time snapshot).
 *
 * Format-agnostic: the phrase regexes match the embedded message text, so both
 * csvlog ("...,LOG,00000,"message"...") and stderr ("... LOG: message") parse.
 *
 * PRIVACY: only the parsed counts + up to 5 RECONSTRUCTED sample phrases are
 * retained - built from the regex captures (lock type / relid / duration /
 * cancellation reason), NEVER the raw log line. This is deliberate: a csvlog
 * row carries the offending STATEMENT TEXT in a later column, so storing a raw
 * line slice could leak a customer query literal. The reconstructed phrase
 * contains only lock metadata, so analysis.json can never carry query text.
 */

export type LockWaveCoverage = {
  from: string | null;
  to: string | null;
  files: number;
  bytesScanned: number;
};

/**
 * One lock-wait or lock-acquired log line, kept so a cascade can say WHO waited
 * for WHAT. Lock metadata and session labels only - never the statement text.
 */
export type LockWaveEvent = {
  minute: string;
  kind: "waiting" | "acquired";
  mode: string;
  relid: number | null;
  /** schema.table, filled by collect.ts when the relid resolves (best effort). */
  relation: string | null;
  pid: number;
  /** From the DETAIL line "Process(es) holding the lock: a, b." (empty when absent). */
  holders: number[];
  /** From "Wait queue: x, y." (empty when absent). */
  queue: number[];
  waitMs: number;
  /** application_name / user_name of the logging session; null when the format lacks them. */
  appName: string | null;
  userName: string | null;
  /** application_name of each holder pid that logged any row in the scanned text. */
  holderApps: string[];
};

/** Per-bucket and per-verdict cap on kept events. */
export const MAX_LOCK_EVENTS = 20;

/** Default application_name of the analyser's own sessions (see sqlrunner.sessionGuard). */
export const ANALYSER_APP_NAME = "pg-analyser";

/**
 * application_name the analyser sets on its own sessions: PG_ANALYSER_APPLICATION_NAME
 * when set, else "pg-analyser". Sanitised like the other session-guard values
 * (the result is inlined into a SET): letters, digits, space, '.', '_', '-'.
 */
export function analyserAppName(env: Record<string, string | undefined> = process.env): string {
  const v = (env.PG_ANALYSER_APPLICATION_NAME ?? "").replace(/[^0-9a-z ._-]/gi, "").trim();
  return v || ANALYSER_APP_NAME;
}

export type LockWaveBucket = {
  minute: string; // "2026-07-15 18:15" or "window" when timestamps are unparseable
  waiting: number;
  maxWaitMs: number;
  acquired: number;
  cancelsLock: number;
  cancelsStmt: number;
  cancelsUser: number;
  deadlocks: number;
  /** Optional: absent in analysis.json written before wait events were kept. */
  events?: LockWaveEvent[];
};

export type LockWaveSummary = {
  coverage: LockWaveCoverage;
  buckets: LockWaveBucket[];
  topRelations: Array<{ relid: number; name: string | null; hits: number }>;
  samples: string[];
};

// Phrase regexes verified against the PG docs message strings; stable 15-17.
// The relation-id capture is optional (transaction/tuple waits carry no relid).
const RE_WAITING =
  /still waiting for (\w+) on (?:relation (\d+) of database \d+|transaction \d+|tuple [^"]*?) after ([\d.]+) ms/;
const RE_ACQUIRED =
  /acquired (\w+) on (?:relation (\d+) of database \d+|transaction \d+|tuple [^"]*?) after ([\d.]+) ms/;
const RE_CANCEL_LOCK = /canceling statement due to lock timeout/;
const RE_CANCEL_STMT = /canceling statement due to statement timeout/;
const RE_CANCEL_USER = /canceling statement due to user request/;
const RE_DEADLOCK = /deadlock detected/;
// Minute bucket: tolerant of csvlog ("2026-07-15 18:15:46.123 UTC,...") and
// stderr prefixes. Unparseable timestamps fall back to a single "window" bucket.
const RE_TS = /(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/;

const RE_PID = /process (\d+) (?:still waiting|acquired)/;
// DETAIL of a lock-wait line (PG docs: errdetail_log_plural in proc.c). stderr
// logs it on its own line; csvlog puts it in the `detail` column of the same row.
const RE_HOLDERS = /Process(?:es)? holding the lock: ([\d, ]+)\. Wait queue: ([\d, ]*)\./;
// csvlog record start: "2026-10-09 00:22:10.100 UTC," (the timestamp is column 1).
const RE_CSV_START = /^\d{4}-\d{2}-\d{2}[ T][\d:.]+ [A-Za-z0-9+:-]+,/;
// pid (column 4) of a csvlog row, tolerating quoted user/database names.
const RE_CSV_PID = /^[^,]*,(?:"[^"]*"|[^,]*),(?:"[^"]*"|[^,]*),(\d+),/;
const CSV_SEVERITIES = new Set([
  "DEBUG1",
  "DEBUG2",
  "DEBUG3",
  "DEBUG4",
  "DEBUG5",
  "INFO",
  "NOTICE",
  "WARNING",
  "ERROR",
  "LOG",
  "FATAL",
  "PANIC",
]);
const MAX_RECORD_LINES = 200;

/** Split one csvlog record into its fields (RFC 4180 quoting, "" escapes). */
function parseCsvFields(rec: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < rec.length; i++) {
    const c = rec[i];
    if (inQ) {
      if (c === '"') {
        if (rec[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/**
 * The csvlog record starting at lines[i]: later lines are appended while a
 * quoted field (typically the multi-line `query` column, which sits BEFORE
 * application_name) is still open. Non-csv lines are returned as-is.
 */
function recordAt(lines: string[], i: number): string {
  let rec = lines[i] ?? "";
  if (!RE_CSV_START.test(rec)) return rec;
  let n = 0;
  while (
    (rec.split('"').length - 1) % 2 === 1 &&
    i + 1 + n < lines.length &&
    n < MAX_RECORD_LINES
  ) {
    n++;
    rec += `\n${lines[i + n]}`;
  }
  return rec;
}

/**
 * Column layout of a standard csvlog row, anchored on severity + sqlstate
 * (columns 12-13) so a sloppy row with fewer columns yields nulls instead of
 * misreading a field: message = severity + 2, detail = +3, application_name =
 * message + 9 (column 23). Returns null when the row is not that layout.
 */
function csvColumns(fields: string[]): {
  user: string | null;
  detail: string;
  app: string | null;
} | null {
  if (!CSV_SEVERITIES.has(fields[11] ?? "") || !/^[0-9A-Z]{5}$/.test(fields[12] ?? "")) return null;
  const tidy = (v: string | undefined) => {
    const t = (v ?? "")
      .replace(/[^\x20-\x7e]/g, "")
      .trim()
      .slice(0, 63);
    return t || null;
  };
  return { user: tidy(fields[1]), detail: fields[14] ?? "", app: tidy(fields[22]) };
}

const pidList = (v: string | undefined): number[] =>
  (v ?? "")
    .split(",")
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isInteger(n) && n > 0)
    .slice(0, MAX_LOCK_EVENTS);

function emptyBucket(minute: string): LockWaveBucket {
  return {
    minute,
    waiting: 0,
    maxWaitMs: 0,
    acquired: 0,
    cancelsLock: 0,
    cancelsStmt: 0,
    cancelsUser: 0,
    deadlocks: 0,
  };
}

function buildEvent(
  lines: string[],
  li: number,
  minute: string,
  kind: LockWaveEvent["kind"],
  m: RegExpExecArray,
): LockWaveEvent | null {
  const first = (lines[li] ?? "").trim();
  const pid = Number(RE_PID.exec(first)?.[1]);
  if (!Number.isInteger(pid)) return null;
  let holdersText: RegExpExecArray | null = null;
  let appName: string | null = null;
  let userName: string | null = null;
  if (RE_CSV_START.test(first)) {
    const cols = csvColumns(parseCsvFields(recordAt(lines, li)));
    if (cols) {
      holdersText = RE_HOLDERS.exec(cols.detail);
      appName = cols.app;
      userName = cols.user;
    }
  } else {
    // stderr: DETAIL is its own line right after the wait line.
    holdersText = RE_HOLDERS.exec(lines[li + 1] ?? "");
  }
  return {
    minute,
    kind,
    mode: m[1] ?? "",
    relid: m[2] ? Number(m[2]) : null,
    relation: null,
    pid,
    holders: pidList(holdersText?.[1]),
    queue: pidList(holdersText?.[2]),
    waitMs: Number(m[3]),
    appName,
    userName,
    holderApps: [],
  };
}

export function parseLockLog(text: string, coverage: LockWaveCoverage): LockWaveSummary {
  const buckets = new Map<string, LockWaveBucket>();
  const relHits = new Map<number, number>();
  const samples: string[] = [];
  const lines = text.split("\n");
  const pidApp = new Map<number, string>();

  for (let li = 0; li < lines.length; li++) {
    const line = (lines[li] ?? "").trim();
    if (!line) continue;
    const hitCancelL = RE_CANCEL_LOCK.test(line);
    const hitCancelS = RE_CANCEL_STMT.test(line);
    const hitCancelU = RE_CANCEL_USER.test(line);
    const hitDead = RE_DEADLOCK.test(line);
    const mWait = RE_WAITING.exec(line);
    const mAcq = RE_ACQUIRED.exec(line);
    if (!(hitCancelL || hitCancelS || hitCancelU || hitDead || mWait || mAcq)) continue;

    const ts = RE_TS.exec(line);
    const minute = ts ? `${ts[1]} ${ts[2]}` : "window";
    const b = buckets.get(minute) ?? emptyBucket(minute);
    // Reconstruct a literal-free sample phrase from the MATCH (never the raw
    // line): match[0] of these regexes is pure lock metadata, so the offending
    // statement text (a later csvlog column) can never end up in the sample.
    let phrase: string | null = null;
    if (mWait) {
      b.waiting++;
      b.maxWaitMs = Math.max(b.maxWaitMs, Number(mWait[3]));
      if (mWait[2]) relHits.set(+mWait[2], (relHits.get(+mWait[2]) ?? 0) + 1);
      phrase = mWait[0];
    }
    if (mWait || mAcq) {
      const m = (mWait ?? mAcq) as RegExpExecArray;
      const ev = buildEvent(lines, li, minute, mWait ? "waiting" : "acquired", m);
      if (ev) {
        if (ev.appName) pidApp.set(ev.pid, ev.appName);
        b.events ??= [];
        if (b.events.length < MAX_LOCK_EVENTS) b.events.push(ev);
      }
    }
    if (mAcq) {
      b.acquired++;
      b.maxWaitMs = Math.max(b.maxWaitMs, Number(mAcq[3]));
      if (mAcq[2]) relHits.set(+mAcq[2], (relHits.get(+mAcq[2]) ?? 0) + 1);
      phrase ??= mAcq[0];
    }
    if (hitCancelL) {
      b.cancelsLock++;
      phrase ??= "canceling statement due to lock timeout";
    }
    if (hitCancelS) {
      b.cancelsStmt++;
      phrase ??= "canceling statement due to statement timeout";
    }
    if (hitCancelU) {
      b.cancelsUser++;
      phrase ??= "canceling statement due to user request";
    }
    if (hitDead) {
      b.deadlocks++;
      phrase ??= "deadlock detected";
    }
    buckets.set(minute, b);
    // Prefix the minute (safe) so a sample is locatable; cap defensively at 200.
    if (phrase && samples.length < 5) samples.push(`${minute} ${phrase}`.slice(0, 200));
  }

  // Holder application_name: a holder rarely logs a lock line itself, so look
  // for ANY csvlog row by a holder/queue pid. Only runs when waits were seen.
  const wanted = new Set<number>();
  for (const b of buckets.values())
    for (const e of b.events ?? []) for (const p of e.holders) if (!pidApp.has(p)) wanted.add(p);
  if (wanted.size > 0) {
    for (let li = 0; li < lines.length && wanted.size > 0; li++) {
      const m = RE_CSV_PID.exec(lines[li] ?? "");
      const pid = m ? Number(m[1]) : NaN;
      if (!wanted.has(pid)) continue;
      const cols = csvColumns(parseCsvFields(recordAt(lines, li)));
      if (cols?.app) {
        pidApp.set(pid, cols.app);
        wanted.delete(pid);
      }
    }
  }
  for (const b of buckets.values())
    for (const e of b.events ?? [])
      e.holderApps = [
        ...new Set(e.holders.map((p) => pidApp.get(p)).filter((x): x is string => !!x)),
      ];

  return {
    coverage,
    buckets: [...buckets.values()].sort((a, b) => a.minute.localeCompare(b.minute)),
    topRelations: [...relHits.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([relid, hits]) => ({ relid, name: null, hits })),
    samples,
  };
}

/**
 * Rolling-window severity classifier over the parsed buckets. Practitioner
 * defaults, not Postgres mandates (documented in docs/heuristics.md). Returns
 * the worst window's stats + the derived severity, or null when nothing fires.
 */
export type LockWaveVerdict = {
  /**
   * "cascade": lock evidence in the window (waits, lock-timeout cancels or a
   * deadlock) - the lock-queue signature. "stmt_timeout": ONLY statement_timeout
   * cancellations, no lock line at all - slow statements hitting their timeout
   * (role-level 3s/8s on Supabase, a batch job, an I/O stall), which the lock
   * remediation (lock_timeout on migrations) does not address. Measured on a
   * live report: 74 statement cancels in two minutes with zero lock waits were
   * being titled "Lock-wait cascade ... 0 waits up to 0s".
   */
  kind: "cascade" | "stmt_timeout";
  severity: "high" | "med" | "low";
  windowFrom: string;
  windowTo: string;
  /**
   * false for the "window" one-off bucket (unparseable timestamps folded into
   * a single aggregate, per parseLockLog's RE_TS fallback) - windowFrom/windowTo
   * are then a best-effort approximation (the scanned buckets' overall span),
   * not this verdict's actual window, so callers must not render them as a
   * real "from-to" range (that produced the literal, non-actionable title
   * "Lock-wait cascade window-window: ..." on a live report).
   */
  windowResolved: boolean;
  waiting: number;
  /** cancelsLock + cancelsStmt (kept for callers that only need the total). */
  cancels: number;
  cancelsLock: number;
  /**
   * Statement-timeout cancels that count toward this verdict. For a cascade
   * that is only those in minutes carrying lock evidence (see classifyLockWave).
   */
  cancelsStmt: number;
  /**
   * Cascade only: statement-timeout cancels in the window's minutes with no
   * lock evidence of their own. Reported, not graded.
   */
  cancelsStmtBackground?: number;
  maxWaitMs: number;
  deadlocks: number;
  /** Wait/acquired events in the window, <= MAX_LOCK_EVENTS, waits first. */
  events?: LockWaveEvent[];
  /**
   * Distinct application_name values of every waiter and known holder in the
   * window (uncapped events, so the own-session check cannot be missed by the
   * 20-event cap). <= MAX_LOCK_EVENTS names.
   */
  involvedApps?: string[];
};

/** A minute carries lock evidence of its own: a wait, a lock-timeout cancel or a deadlock. */
const minuteHasLockEvidence = (b: LockWaveBucket): boolean =>
  b.waiting > 0 || b.cancelsLock > 0 || b.deadlocks > 0;

export function classifyLockWave(s: LockWaveSummary, windowMinutes = 10): LockWaveVerdict | null {
  const b = s.buckets.filter((x) => x.minute !== "window");
  // Fold the (single) "window" bucket in as its own one-off window too.
  const oneOff = s.buckets.find((x) => x.minute === "window");
  let best: LockWaveVerdict | null = null;
  const rank = (v: Pick<LockWaveVerdict, "kind" | "severity">): number =>
    (v.kind === "cascade" ? 2e6 : 0) +
    (v.severity === "high" ? 1e6 : v.severity === "med" ? 5e5 : 0);
  const consider = (from: string, to: string, resolved: boolean, win: LockWaveBucket[]) => {
    const waiting = win.reduce((n, w) => n + w.waiting, 0);
    const cancelsLock = win.reduce((n, w) => n + w.cancelsLock, 0);
    const deadlocks = win.reduce((n, w) => n + w.deadlocks, 0);
    const maxWaitMs = Math.max(0, ...win.map((w) => w.maxWaitMs));
    const stmtAll = win.reduce((n, w) => n + w.cancelsStmt, 0);
    // Statement-timeout cancels corroborate a cascade only in a MINUTE that
    // itself carries lock evidence (a wait, a lock-timeout cancel, a deadlock).
    // They also run as steady platform background (1-2 per minute for hours in
    // a measured report); summing that over a 10-minute window that happened
    // to hold five waits produced "10 timeout cancellations" and a MED cascade
    // from five 1-12 s waits. Lock-timeout cancels are lock evidence by
    // themselves and count everywhere.
    const stmtCounted = win.reduce((n, w) => n + (minuteHasLockEvidence(w) ? w.cancelsStmt : 0), 0);
    // Window-level gate for the kind: any lock evidence at all in the window.
    const lockEvidence = waiting > 0 || cancelsLock > 0 || deadlocks > 0;
    const cancelsStmt = lockEvidence ? stmtCounted : stmtAll;
    const cancels = cancelsLock + cancelsStmt;
    let kind: LockWaveVerdict["kind"];
    let severity: LockWaveVerdict["severity"];
    if (lockEvidence && (cancels >= 50 || (maxWaitMs >= 60_000 && waiting >= 10))) {
      kind = "cascade";
      severity = "high";
    } else if (lockEvidence && (waiting >= 10 || cancels >= 10 || deadlocks >= 1)) {
      kind = "cascade";
      severity = "med";
    } else if (!lockEvidence && cancelsStmt >= 50) {
      kind = "stmt_timeout";
      severity = "med";
    } else if (!lockEvidence && cancelsStmt >= 10) {
      kind = "stmt_timeout";
      severity = "low";
    } else return;
    // A cascade outranks a timeout burst, then severity, then volume.
    // An unresolved bucket aggregates the whole scanned span, so the 10-minute
    // thresholds above can't grade it - report the signal, at low.
    if (!resolved) severity = "low";
    const events = win
      .flatMap((w) => w.events ?? [])
      .sort((x, y) => (x.kind === y.kind ? 0 : x.kind === "waiting" ? -1 : 1))
      .slice(0, MAX_LOCK_EVENTS)
      .sort((x, y) => x.minute.localeCompare(y.minute));
    const cand: LockWaveVerdict = {
      kind,
      severity,
      windowFrom: from,
      windowTo: to,
      windowResolved: resolved,
      waiting,
      cancels,
      cancelsLock,
      cancelsStmt,
      maxWaitMs,
      deadlocks,
    };
    if (kind === "cascade") cand.cancelsStmtBackground = stmtAll - stmtCounted;
    if (events.length > 0) cand.events = events;
    const apps = [
      ...new Set(
        win.flatMap((w) => w.events ?? []).flatMap((e) => [e.appName ?? "", ...e.holderApps]),
      ),
    ]
      .filter(Boolean)
      .slice(0, MAX_LOCK_EVENTS);
    if (apps.length > 0) cand.involvedApps = apps;
    const score = rank(cand) + cancels * 100 + waiting + maxWaitMs / 1000;
    const bestScore = best
      ? rank(best) + best.cancels * 100 + best.waiting + best.maxWaitMs / 1000
      : -1;
    if (score > bestScore) best = cand;
  };

  // Slide a windowMinutes WALL-CLOCK window across the timestamped buckets. A
  // bucket's minute is "YYYY-MM-DD HH:MM"; window by real elapsed time, NOT by
  // bucket count - logs are sparse (a bucket only exists for a minute that had
  // a lock event), so a fixed bucket count would span hours and over-aggregate
  // spread-out background noise into a false cascade.
  const tOf = (minute: string) => {
    const ms = Date.parse(`${minute.replace(" ", "T")}:00Z`);
    return Number.isFinite(ms) ? ms : null;
  };
  const windowMs = windowMinutes * 60_000;
  for (let i = 0; i < b.length; i++) {
    const start = tOf(b[i]!.minute);
    const win: LockWaveBucket[] = [];
    let lastIdx = i;
    for (let j = i; j < b.length; j++) {
      const tj = tOf(b[j]!.minute);
      // Stop once we pass the wall-clock window (unparseable timestamps fall
      // back to inclusion so nothing is silently dropped).
      if (start != null && tj != null && tj - start >= windowMs) break;
      win.push(b[j]!);
      lastIdx = j;
    }
    consider(b[i]!.minute, b[lastIdx]!.minute, true, win);
  }
  if (oneOff)
    // Unparseable-timestamp events: windowFrom/windowTo carry the overall
    // scanned span as a best-effort approximation (not this bucket's actual
    // window - it has none), so findings.ts must not render them as a real
    // "from-to" range. See LockWaveVerdict.windowResolved.
    consider(
      s.coverage.from ?? "unresolved timestamp",
      s.coverage.to ?? "unresolved timestamp",
      false,
      [oneOff],
    );
  return best;
}
