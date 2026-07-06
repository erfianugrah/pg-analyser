/**
 * Lightweight structured logger.
 *
 * Deliberately NOT pino. sbperf compiles to a standalone binary via
 * `bun build --compile`, and pino's transports + pretty-printer run on worker
 * threads that don't survive single-file compile (its JSON-to-fd core would
 * work, but the value-add is exactly the part that breaks). Our logging need is
 * modest - per-plane timing + level-gated diagnostics - so a zero-dep logger
 * fits the minimal-deps ethos better than pulling pino in.
 *
 * Everything goes to STDERR: stdout is reserved for report/JSON output and
 * piping (`diff`, `check`, and any `... > out.json`). Config via env:
 *   SBPERF_LOG_LEVEL = debug | info | warn | error   (default: info)
 *   SBPERF_LOG       = json                            (default: pretty)
 * `error` is the effective floor when a level is unrecognised.
 */

export type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const LEVELS = ["debug", "info", "warn", "error"] as const;

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  /** Derive a logger with permanently-bound fields (e.g. { ref }). */
  child(bound: Record<string, unknown>): Logger;
  /**
   * Start a timer. Call the returned function to emit a `debug` line carrying
   * `durationMs` (plus any extra fields) and get the elapsed ms back.
   */
  time(msg: string, fields?: Record<string, unknown>): (extra?: Record<string, unknown>) => number;
}

export interface LoggerOptions {
  level?: Level;
  json?: boolean;
  /** Sink for one formatted line (no trailing newline). Default: stderr. */
  sink?: (line: string) => void;
  /** Clock, injectable for tests. Default: performance.now. */
  now?: () => number;
  /** Bound fields carried on every line. */
  bound?: Record<string, unknown>;
}

export function envLevel(): Level {
  const v = (process.env.SBPERF_LOG_LEVEL ?? "info").toLowerCase();
  return (LEVELS as readonly string[]).includes(v) ? (v as Level) : "info";
}

const defaultSink = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

function fmtPretty(level: Level, msg: string, fields: Record<string, unknown>): string {
  const parts = Object.entries(fields).map(([k, v]) => `${k}=${fmtVal(v)}`);
  const tag = level.toUpperCase().padEnd(5);
  return parts.length ? `${tag} ${msg} ${parts.join(" ")}` : `${tag} ${msg}`;
}

function fmtVal(v: unknown): string {
  if (v == null) return String(v);
  if (typeof v === "string") return /\s/.test(v) ? JSON.stringify(v) : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

export function makeLogger(opts: LoggerOptions = {}): Logger {
  const level = opts.level ?? envLevel();
  const json = opts.json ?? process.env.SBPERF_LOG === "json";
  const sink = opts.sink ?? defaultSink;
  const now = opts.now ?? (() => performance.now());
  const bound = opts.bound ?? {};
  const floor = ORDER[level];

  const emit = (lvl: Level, msg: string, fields?: Record<string, unknown>): void => {
    if (ORDER[lvl] < floor) return;
    const merged = { ...bound, ...(fields ?? {}) };
    if (json) {
      sink(JSON.stringify({ level: lvl, time: new Date().toISOString(), msg, ...merged }));
    } else {
      sink(fmtPretty(lvl, msg, merged));
    }
  };

  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    child: (b) => makeLogger({ ...opts, level, json, sink, now, bound: { ...bound, ...b } }),
    time: (msg, fields) => {
      const start = now();
      return (extra) => {
        const durationMs = Math.round(now() - start);
        emit("debug", msg, { ...(fields ?? {}), ...(extra ?? {}), durationMs });
        return durationMs;
      };
    },
  };
}

/** Process-wide default logger, configured from the environment. */
export const log: Logger = makeLogger();
