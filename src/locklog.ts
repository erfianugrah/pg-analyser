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

export type LockWaveBucket = {
  minute: string; // "2026-07-15 18:15" or "window" when timestamps are unparseable
  waiting: number;
  maxWaitMs: number;
  acquired: number;
  cancelsLock: number;
  cancelsStmt: number;
  cancelsUser: number;
  deadlocks: number;
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

export function parseLockLog(text: string, coverage: LockWaveCoverage): LockWaveSummary {
  const buckets = new Map<string, LockWaveBucket>();
  const relHits = new Map<number, number>();
  const samples: string[] = [];

  for (const raw of text.split("\n")) {
    const line = raw.trim();
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
  severity: "high" | "med";
  windowFrom: string;
  windowTo: string;
  waiting: number;
  cancels: number;
  maxWaitMs: number;
  deadlocks: number;
};

export function classifyLockWave(s: LockWaveSummary, windowMinutes = 10): LockWaveVerdict | null {
  const b = s.buckets.filter((x) => x.minute !== "window");
  // Fold the (single) "window" bucket in as its own one-off window too.
  const oneOff = s.buckets.find((x) => x.minute === "window");
  let best: LockWaveVerdict | null = null;
  const consider = (
    from: string,
    to: string,
    waiting: number,
    cancels: number,
    maxWaitMs: number,
    deadlocks: number,
  ) => {
    const high = cancels >= 50 || (maxWaitMs >= 60_000 && waiting >= 10);
    const med = waiting >= 10 || cancels >= 10 || deadlocks >= 1;
    if (!high && !med) return;
    const severity = high ? "high" : "med";
    // Prefer HIGH over MED, then the larger cancel+wait volume.
    const score = (high ? 1e6 : 0) + cancels * 100 + waiting + maxWaitMs / 1000;
    const bestScore = best
      ? (best.severity === "high" ? 1e6 : 0) +
        best.cancels * 100 +
        best.waiting +
        best.maxWaitMs / 1000
      : -1;
    if (score > bestScore)
      best = { severity, windowFrom: from, windowTo: to, waiting, cancels, maxWaitMs, deadlocks };
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
    let waiting = 0;
    let cancels = 0;
    let maxWaitMs = 0;
    let deadlocks = 0;
    let lastIdx = i;
    for (let j = i; j < b.length; j++) {
      const tj = tOf(b[j]!.minute);
      // Stop once we pass the wall-clock window (unparseable timestamps fall
      // back to inclusion so nothing is silently dropped).
      if (start != null && tj != null && tj - start >= windowMs) break;
      const w = b[j]!;
      waiting += w.waiting;
      cancels += w.cancelsLock + w.cancelsStmt;
      maxWaitMs = Math.max(maxWaitMs, w.maxWaitMs);
      deadlocks += w.deadlocks;
      lastIdx = j;
    }
    consider(b[i]!.minute, b[lastIdx]!.minute, waiting, cancels, maxWaitMs, deadlocks);
  }
  if (oneOff)
    consider(
      "window",
      "window",
      oneOff.waiting,
      oneOff.cancelsLock + oneOff.cancelsStmt,
      oneOff.maxWaitMs,
      oneOff.deadlocks,
    );
  return best;
}
