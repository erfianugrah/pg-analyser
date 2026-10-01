/**
 * Pure server-log restart classifier. Pairs each startup line with the stop
 * that preceded it and says how the stop ended - the one record that tells a
 * clean restart from one cut off mid-shutdown, which a cumulative-stats reset
 * cannot (whether a cut-off stop loses the stats depends on the Postgres
 * version: see AGENTS.md 2026-10-01).
 *
 * Stop side (in order): `received {fast|smart|immediate} shutdown request`,
 * `checkpoint starting: shutdown`, `checkpoint complete`, `database system is
 * shut down`. Start side: `database system was shut down at` (clean control
 * file), `database system shutdown was interrupted` / `database system was
 * interrupted` / `database system was not properly shut down` (recovery).
 * Message strings verified on postgres:17.4/17.11/18.6 containers, 2026-10-01.
 *
 * Format-agnostic like locklog.ts: the regexes match embedded message text, so
 * csvlog and stderr both parse. PRIVACY: only timestamps and enums are kept.
 */

export type RestartVerdict =
  /** Stop logged `database system is shut down`, start was clean. */
  | "clean"
  /** Clean start; the stop side is outside the scanned text. */
  | "clean_stop_unseen"
  /** Shutdown checkpoint finished but `is shut down` never logged; clean start. */
  | "stop_cut_off_clean_start"
  /** A shutdown request, then a start that ran crash recovery. */
  | "stop_cut_off_recovered"
  /** Crash recovery with no shutdown request before it. */
  | "crash";

export type RestartEvent = {
  /** Startup time, "YYYY-MM-DD HH:MM:SS" as logged (server timezone). */
  at: string;
  stopAt: string | null;
  stopMode: "fast" | "smart" | "immediate" | null;
  shutdownCheckpoint: "none" | "started" | "completed";
  shutDownLogged: boolean;
  startup: "clean" | "recovery";
  verdict: RestartVerdict;
};

export type RestartSummary = {
  /** Restarts found in the scanned text (restarts[] may be capped). */
  total: number;
  /** Newest MAX_RESTARTS, oldest first. */
  restarts: RestartEvent[];
};

const MAX_RESTARTS = 20;
/** A stop request this long before a startup still pairs with it. */
const STOP_PAIR_WINDOW_S = 30 * 60;
/** Startup lines this close together belong to one startup. */
const STARTUP_GROUP_S = 120;

const RE_TS = /(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/;
const RE_STOP = /received (fast|smart|immediate) shutdown request/;
const RE_CKPT_START = /checkpoint starting: shutdown/;
const RE_CKPT_DONE = /checkpoint complete:/;
const RE_SHUT_DOWN = /database system is shut down/;
const RE_START_CLEAN = /database system was shut down at/;
const RE_START_RECOVERY =
  /database system shutdown was interrupted|database system was interrupted|database system was not properly shut down/;

type Ev =
  | { kind: "stop"; t: number; ts: string; mode: "fast" | "smart" | "immediate" }
  | {
      kind: "ckpt_start" | "ckpt_done" | "shut_down" | "start_clean" | "start_recovery";
      t: number;
      ts: string;
    };

function tOf(date: string, time: string): number | null {
  const ms = Date.parse(`${date}T${time}Z`);
  return Number.isFinite(ms) ? ms / 1000 : null;
}

export function parseRestartLog(text: string): RestartSummary | null {
  if (!text) return null;
  const evs: Ev[] = [];
  for (const raw of text.split("\n")) {
    const m = RE_TS.exec(raw);
    if (!m) continue;
    const t = tOf(m[1]!, m[2]!);
    if (t == null) continue;
    const ts = `${m[1]} ${m[2]}`;
    const stop = RE_STOP.exec(raw);
    if (stop) evs.push({ kind: "stop", t, ts, mode: stop[1] as "fast" | "smart" | "immediate" });
    else if (RE_CKPT_START.test(raw)) evs.push({ kind: "ckpt_start", t, ts });
    else if (RE_CKPT_DONE.test(raw)) evs.push({ kind: "ckpt_done", t, ts });
    else if (RE_SHUT_DOWN.test(raw)) evs.push({ kind: "shut_down", t, ts });
    else if (RE_START_CLEAN.test(raw)) evs.push({ kind: "start_clean", t, ts });
    else if (RE_START_RECOVERY.test(raw)) evs.push({ kind: "start_recovery", t, ts });
  }
  // collect.ts joins file tails newest-first; restore time order.
  evs.sort((a, b) => a.t - b.t);

  type Stop = {
    t: number;
    ts: string;
    mode: "fast" | "smart" | "immediate";
    ckpt: "none" | "started" | "completed";
    shutDown: boolean;
  };
  let stop: Stop | null = null;
  const out: RestartEvent[] = [];
  let open: { ev: RestartEvent; t: number } | null = null;

  for (const e of evs) {
    if (e.kind === "stop") {
      stop = { t: e.t, ts: e.ts, mode: e.mode, ckpt: "none", shutDown: false };
      open = null;
    } else if (e.kind === "ckpt_start") {
      if (stop && stop.ckpt === "none") stop.ckpt = "started";
    } else if (e.kind === "ckpt_done") {
      // Only the checkpoint a shutdown started; routine ones are ignored.
      if (stop && stop.ckpt === "started") stop.ckpt = "completed";
    } else if (e.kind === "shut_down") {
      if (stop) stop.shutDown = true;
    } else {
      const recovery = e.kind === "start_recovery";
      if (open && e.t - open.t <= STARTUP_GROUP_S) {
        // A second startup line of the same startup; recovery wins.
        if (recovery && open.ev.startup === "clean") {
          open.ev.startup = "recovery";
          open.ev.verdict = open.ev.stopMode ? "stop_cut_off_recovered" : "crash";
        }
        continue;
      }
      const paired = stop && e.t - stop.t <= STOP_PAIR_WINDOW_S ? stop : null;
      const startup = recovery ? "recovery" : "clean";
      const verdict: RestartVerdict = recovery
        ? paired
          ? "stop_cut_off_recovered"
          : "crash"
        : !paired
          ? "clean_stop_unseen"
          : paired.shutDown
            ? "clean"
            : "stop_cut_off_clean_start";
      const ev: RestartEvent = {
        at: e.ts,
        stopAt: paired?.ts ?? null,
        stopMode: paired?.mode ?? null,
        shutdownCheckpoint: paired?.ckpt ?? "none",
        shutDownLogged: paired?.shutDown ?? false,
        startup,
        verdict,
      };
      out.push(ev);
      open = { ev, t: e.t };
      stop = null;
    }
  }
  if (out.length === 0) return null;
  return { total: out.length, restarts: out.slice(-MAX_RESTARTS) };
}
