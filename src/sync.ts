import { createHash } from "node:crypto";
import { HEURISTICS_REVIEWED } from "./heuristics.ts";
import type { SyncStatus } from "./schemas.ts";
import { SPLINTER_SQL } from "./splinter.ts";

/**
 * On-by-default, soft-fail upstream sync check, surfaced in the report footer.
 *
 * Two signals:
 *  1. OFFLINE (always): the heuristics catalog vintage (HEURISTICS_REVIEWED) and
 *     its age. The catalog is grounded in Supabase/Postgres docs that have no
 *     single machine-checkable fingerprint, so staleness here is age-based - a
 *     nudge to re-confirm the thresholds after ~6 months.
 *  2. ONLINE (best-effort): the vendored advisor lint SQL (src/splinter.sql, the
 *     superuser fallback for the hosted Performance Advisor) hashed against
 *     upstream `supabase/splinter`. A mismatch means our fallback lints drifted.
 *
 * Soft-fail by design: any network error leaves the online signal unchecked
 * (advisorSqlDrifted: null) with a note, so a run stays reproducible offline.
 * The live advisor lints themselves are always current (fetched per run via the
 * Management API); this only tracks the OFFLINE fallback + catalog vintage.
 */

const STALE_DAYS = 183; // ~6 months
const SPLINTER_UPSTREAM = "https://raw.githubusercontent.com/supabase/splinter/main/splinter.sql";
const DEFAULT_TIMEOUT_MS = 4000;

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/**
 * Normalize before hashing so a local provenance header (leading `--`/blank
 * lines we add to the vendored copy) does not read as upstream drift. Only
 * LEADING comment/blank lines are stripped - comments inside the lint body are
 * kept, so a genuine change there is still caught.
 */
export function stripLeadingComments(sql: string): string {
  const lines = sql.split("\n");
  let i = 0;
  while (i < lines.length && /^\s*(--.*)?$/.test(lines[i] ?? "")) i++;
  return lines.slice(i).join("\n").trimEnd();
}

/** Days between the catalog vintage (YYYY-MM, taken as the 1st) and `now`. */
export function catalogAgeDays(reviewed: string, now: Date): number {
  const [y, m] = reviewed.split("-").map(Number);
  if (!y || !m) return 0;
  const base = Date.UTC(y, m - 1, 1);
  return Math.max(0, Math.floor((now.getTime() - base) / 86_400_000));
}

/** One-line human summary for the report footer. */
function buildNote(s: Omit<SyncStatus, "note">): string {
  const age = s.stale
    ? `Heuristics catalog vintage ${s.catalogReviewed} is ~${Math.round(s.ageDays / 30.4)} months old (re-review recommended).`
    : `Heuristics catalog vintage ${s.catalogReviewed} (current).`;
  const up = !s.upstreamChecked
    ? "Upstream not reached; sync check skipped (offline)."
    : s.advisorSqlDrifted
      ? "Upstream advisor lint SQL changed since it was vendored - re-review src/splinter.sql."
      : "Advisor lint SQL matches upstream.";
  return `${age} ${up}`;
}

export async function computeSyncStatus(
  opts: {
    now?: Date;
    check?: boolean;
    vendored?: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<SyncStatus> {
  const now = opts.now ?? new Date();
  const check = opts.check ?? true;
  const vendored = opts.vendored ?? SPLINTER_SQL;
  const doFetch = opts.fetchImpl ?? fetch;

  const ageDays = catalogAgeDays(HEURISTICS_REVIEWED, now);
  const stale = ageDays >= STALE_DAYS;

  let upstreamChecked = false;
  let advisorSqlDrifted: boolean | null = null;

  if (check) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const res = await doFetch(SPLINTER_UPSTREAM, {
        signal: ctrl.signal,
        headers: { accept: "text/plain" },
      });
      if (res.ok) {
        const upstream = await res.text();
        advisorSqlDrifted =
          sha256(stripLeadingComments(upstream)) !== sha256(stripLeadingComments(vendored));
        upstreamChecked = true;
      }
    } catch {
      // soft-fail: leave upstreamChecked=false / advisorSqlDrifted=null
    } finally {
      clearTimeout(timer);
    }
  }

  const partial = {
    catalogReviewed: HEURISTICS_REVIEWED,
    ageDays,
    stale,
    upstreamChecked,
    advisorSqlDrifted,
  };
  return { ...partial, note: buildNote(partial) };
}
