import { appRows } from "./appschema.ts";
import { meta, THRESHOLDS } from "./heuristics.ts";
import { lintFix } from "./lints.ts";
import type { Analysis, SqlRow } from "./schemas.ts";
import { projectDaysTo, sufficient, sustainedFrac, trendStat } from "./trendstats.ts";

export type Severity = "high" | "med" | "low";
export type Category = "Performance" | "Security" | "Capacity";

export interface Finding {
  severity: Severity;
  category: Category;
  title: string;
  anchor: string;
  /** Heuristic id from src/heuristics.ts, if this finding is catalogued. */
  heuristicId?: string;
  /** One-line copy-pasteable fix guidance (from the heuristic). */
  remediation?: string;
  /** The consequence: business + technical impact (from the heuristic). */
  whyItMatters?: string;
  /** How to confirm the fix worked (from the heuristic). */
  howToVerify?: string;
  /** Concrete SQL/DDL command template for the fix (from the heuristic). */
  sql?: string;
  /** Deep-link into the project's own dashboard (e.g. the Advisor page). */
  dashUrl?: string;
  /** Canonical doc/source URL for the reader and the narrate pass to cite. */
  docUrl?: string;
  /** Optional changelog / known-issue URL (documented platform change). */
  changelogUrl?: string;
  /** Optional measured evidence string (e.g. object name + size + %). */
  evidence?: string;
}

/** A confirmed-healthy observation - the "what's looking good" counterweight. */
export interface Positive {
  category: Category;
  title: string;
}

const SEV_RANK: Record<Severity, number> = { high: 0, med: 1, low: 2 };
const CAT_RANK: Record<Category, number> = { Performance: 0, Security: 1, Capacity: 2 };

function sevFromLevel(level: string): Severity {
  if (level === "ERROR") return "high";
  if (level === "WARN") return "med";
  return "low";
}
const worse = (a: string, b: string): string => (sevFromLevel(a) <= sevFromLevel(b) ? a : b);

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Present a count derived from a LIMIT-capped SQL result. When the source array
 * hit its cap the count is a FLOOR, not a total, so append "+" - "20" tables
 * reads as "20+" instead of implying there are exactly 20. `rawLen` is the
 * pre-filter array length (truncation happens at the SQL LIMIT, before any
 * schema filter), `shown` is the number actually being reported.
 */
const countCapped = (rawLen: number, shown: number, limit = 20): string =>
  `${shown}${rawLen >= limit ? "+" : ""}`;

function settingsMap(rows: SqlRow[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of rows) m.set(String(r.name), String(r.setting));
  return m;
}

// Convert a pg_settings row (setting + unit) to bytes. Memory GUCs carry a unit
// of 'kB' / 'MB' / 'GB' / '8kB' (shared_buffers/effective_cache_size use the
// block size). Returns null when the setting is absent or has no memory unit.
const MEM_UNIT_BYTES: Record<string, number> = {
  B: 1,
  kB: 1024,
  MB: 1024 * 1024,
  GB: 1024 * 1024 * 1024,
  "8kB": 8 * 1024,
  "16kB": 16 * 1024,
  "32kB": 32 * 1024,
};
function gucBytes(rows: SqlRow[], name: string): number | null {
  const r = rows.find((x) => String(x.name) === name);
  if (!r) return null;
  const mult = MEM_UNIT_BYTES[String(r.unit ?? "")];
  if (mult == null) return null;
  const v = Number(r.setting);
  return Number.isFinite(v) ? v * mult : null;
}

const bytesGb = (b: number): string => `${(b / (1024 * 1024 * 1024)).toFixed(1)} GB`;

// Space recoverable without losing data: measured/estimated table bloat +
// droppable unused indexes (app-scoped) + WAL pinned by INACTIVE replication
// slots (reclaimed by dropping the slot). The whole pg_wal dir is NOT counted -
// it is baseline overhead the running server needs. Feeds the disk
// over-provisioning finding's "true footprint" (used minus reclaimable).
function reclaimableDiskBytes(a: Analysis): number {
  const exact = a.sql.bloatExact.reduce((s, r) => s + num(r.reclaimable_bytes), 0);
  const bloat = exact > 0 ? exact : a.sql.bloat.reduce((s, r) => s + num(r.waste_bytes), 0);
  const unusedIdx = appRows(a.sql.indexStats)
    .filter((r) => r.unused === true)
    .reduce((s, r) => s + num(r.index_bytes), 0);
  const slotWal = a.sql.replicationSlots
    .filter((r) => r.active === false)
    .reduce((s, r) => s + num(r.retained_wal_bytes), 0);
  return bloat + unusedIdx + slotWal;
}

// Leading UPDATE/DELETE target of a normalized statement (schema-qualified or
// not, quoted or not). Anchored so it only matches the statement's own verb.
const WRITE_RX =
  /^\s*(update|delete)\s+(?:from\s+)?((?:"[^"]+"|[a-zA-Z0-9_]+)(?:\.(?:"[^"]+"|[a-zA-Z0-9_]+))?)/i;

/**
 * Map each table to the UPDATE/DELETE call volume targeting it, deduped by
 * queryid across the query planes. Lets a bloat / dead-tuple finding name the
 * likely CHURN SOURCE (e.g. a hot counter UPDATE driving a table's bloat) that
 * the independent finding cards otherwise leave unconnected. Keyed by the bare
 * table name (last identifier segment) so it matches a schema.table bloat row.
 */
function writeTargets(a: Analysis): Map<string, { calls: number; kind: string }> {
  const map = new Map<string, { calls: number; kind: string }>();
  const seen = new Set<string>();
  for (const r of [...a.sql.topByCalls, ...a.sql.topStatements, ...a.sql.queryIoStats]) {
    const q = String(r.query ?? "");
    const id = String(r.queryid ?? q);
    if (seen.has(id)) continue;
    seen.add(id);
    const m = WRITE_RX.exec(q);
    if (!m?.[1] || !m[2]) continue;
    const table = m[2].replaceAll('"', "").split(".").pop() ?? "";
    if (!table) continue;
    const cur = map.get(table) ?? { calls: 0, kind: m[1].toUpperCase() };
    cur.calls += num(r.calls);
    map.set(table, cur);
  }
  return map;
}

/**
 * Advisor lints whose signal is COUNTER-derived (pg_stat_user_indexes.idx_scan
 * etc.) and therefore only trustworthy over a full stats window - the same
 * short-window caveat the native SQL findings carry must reach these
 * authoritative advisor cards too (the SQL fallback is suppressed when the
 * advisor fires, so without this the caveat would vanish on the card that wins).
 */
const COUNTER_DERIVED_ADVISOR_LINTS = new Set(["unused_index"]);

function groupAdvisors(
  list: Analysis["advisors"]["performance"],
  category: Category,
  anchor: string,
  ref: string | undefined,
  winCaveat: string | null = null,
): Finding[] {
  const byTitle = new Map<
    string,
    { name: string; level: string; count: number; description?: string; remediation?: string }
  >();
  for (const a of list) {
    const g = byTitle.get(a.title) ?? {
      name: a.name,
      level: a.level,
      count: 0,
      description: a.description,
      remediation: a.remediation ?? undefined,
    };
    g.count += 1;
    g.level = worse(g.level, a.level);
    byTitle.set(a.title, g);
  }
  // Deep-link into the project's own Advisor page (the '_' project redirects to
  // the active project in their session when the ref is unknown).
  const page = category === "Security" ? "security" : "performance";
  const dashUrl = `https://supabase.com/dashboard/project/${ref ?? "_"}/advisors/${page}`;
  const base = meta(category === "Security" ? "advisor_security" : "advisor_performance");
  return [...byTitle].map(([title, g]) => {
    // One-stop-shop: the per-lint catalog gives a plain-English title + concrete
    // fix + SQL + verify. Fall back to the lint's own text when uncatalogued.
    const fix = lintFix(g.name);
    // What's happening: the lint's own description + the affected-object scale.
    // Splinter text backslash-escapes quotes/backticks for markdown; unescape so
    // it doesn't render as literal \'role\'.
    const desc = g.description?.replace(/\\(['"`])/g, "$1");
    const scale = g.count > 1 ? `Affects ${g.count} objects.` : "";
    const caveat = winCaveat && COUNTER_DERIVED_ADVISOR_LINTS.has(g.name) ? winCaveat : "";
    const evidence = [desc, scale, caveat].filter(Boolean).join(" ") || undefined;
    return {
      severity: sevFromLevel(g.level),
      category,
      title: fix?.plainTitle ?? (g.count > 1 ? `${title} (${g.count}x)` : title),
      anchor,
      evidence,
      dashUrl,
      ...base,
      remediation: fix?.whatToDo ?? base.remediation,
      sql: fix?.sql,
      howToVerify: fix?.howToVerify ?? base.howToVerify,
      docUrl: g.remediation ?? base.docUrl,
      changelogUrl: fix?.changelogUrl ?? base.changelogUrl,
    };
  });
}

/**
 * Security-config findings from the auth / network / SSL Management planes.
 * Unlike the advisor passthrough, these are sbperf-ORIGINAL Security checks.
 * a.security is null in no-PAT mode (no Management API) - nothing is asserted
 * then. Each sub-plane is independently nullable, so a single 403 (e.g. a
 * beta-gated endpoint) skips just its checks. Fields are optional at the schema
 * boundary, so a check only fires when the value was actually present.
 */
/**
 * Static GUC-tuning findings derived from pgSettings (both modes). Each is a
 * deterministic sanity check on a server setting; the values come from the
 * pg_settings snapshot, so no live workload is required.
 */
export function configTuningFindings(a: Analysis): Finding[] {
  const out: Finding[] = [];
  const rows = a.sql.pgSettings;
  if (rows.length === 0) return out;
  const set = settingsMap(rows);
  const anchor = "#infra";

  // work_mem blast radius: worst-case per-backend memory (work_mem x
  // max_connections x parallel workers) vs RAM estimated from shared_buffers
  // (Supabase provisions shared_buffers ~= 25% of RAM). Flag when the worst
  // case could exceed RAM - a broad OOM risk from a high global work_mem.
  const workMem = gucBytes(rows, "work_mem");
  const sharedBuffers = gucBytes(rows, "shared_buffers");
  const maxConn = num(set.get("max_connections"));
  if (workMem != null && sharedBuffers != null && sharedBuffers > 0 && maxConn > 0) {
    const estRam = sharedBuffers * 4; // shared_buffers ~= 25% of RAM
    const parallel = Math.max(1, num(set.get("max_parallel_workers_per_gather")) || 1) + 1;
    const worstCase = workMem * maxConn * parallel;
    if (worstCase >= estRam * THRESHOLDS.workMemBlastFrac) {
      out.push({
        severity: "med",
        category: "Capacity",
        title: `work_mem worst case (~${bytesGb(worstCase)}) can exceed estimated RAM (~${bytesGb(estRam)})`,
        anchor,
        evidence: `work_mem ${set.get("work_mem")}kB x max_connections ${maxConn} x ~${parallel} ops. RAM estimated from shared_buffers.`,
        ...meta("work_mem_blast"),
      });
    }
  }

  // NOTE: statement_timeout=0 and idle_in_transaction_session_timeout=0 are
  // already handled by dedicated findings (statement_timeout_off /
  // idle_in_txn_timeout_off) elsewhere in deriveFindings - not re-checked here.
  // lock_timeout=0 is intentionally never flagged (a cluster-wide lock_timeout
  // cancels legitimate waits; 0 is the sane global default).

  // maintenance_work_mem too low - RAM-RELATIVE. Supabase auto-scales this with
  // the compute tier (verified: 32MB on a Nano, 64MB on a Micro), so a small
  // absolute value on a small instance is correct, not low. Only flag when it
  // is a tiny fraction of estimated RAM AND the instance is large enough that a
  // bigger value would genuinely help - i.e. the platform tuning is lagging or
  // a custom override set it too low. RAM estimated from shared_buffers (~25%).
  const maintMem = gucBytes(rows, "maintenance_work_mem");
  const sbForMaint = gucBytes(rows, "shared_buffers");
  const estRamForMaint = sbForMaint != null ? sbForMaint * 4 : null;
  if (
    maintMem != null &&
    estRamForMaint != null &&
    estRamForMaint >= THRESHOLDS.maintWorkMemMinRamGb * 1024 * 1024 * 1024 &&
    maintMem / estRamForMaint < THRESHOLDS.maintWorkMemMinFrac
  ) {
    out.push({
      severity: "low",
      category: "Capacity",
      title: `maintenance_work_mem is low for this instance (${Math.round(maintMem / 1024 / 1024)}MB on ~${Math.round(estRamForMaint / 1024 / 1024 / 1024)}GB RAM)`,
      anchor,
      ...meta("maintenance_work_mem_low"),
    });
  }

  // checkpoint_completion_target too low (spiky checkpoint I/O).
  const cct = Number(set.get("checkpoint_completion_target"));
  if (Number.isFinite(cct) && cct > 0 && cct < THRESHOLDS.checkpointCompletionMin) {
    out.push({
      severity: "low",
      category: "Performance",
      title: `checkpoint_completion_target is ${cct} (below 0.9)`,
      anchor,
      ...meta("checkpoint_completion_low"),
    });
  }

  // track_io_timing off (blinds I/O attribution).
  if (set.get("track_io_timing") === "off") {
    out.push({
      severity: "low",
      category: "Performance",
      title: "track_io_timing is off (no per-query I/O timing)",
      anchor,
      ...meta("track_io_timing_off"),
    });
  }

  return out;
}

export function securityConfigFindings(a: Analysis): Finding[] {
  const s = a.security;
  if (!s) return [];
  const out: Finding[] = [];
  const anchor = "#seccfg";
  const ref = a.meta.ref ?? "_";
  const authUrl = `https://supabase.com/dashboard/project/${ref}/auth/providers`;
  const dbUrl = `https://supabase.com/dashboard/project/${ref}/settings/database`;

  // Network restrictions: no allowlist (or a wide-open 0.0.0.0/0 // ::/0) means
  // the Postgres port is reachable from any IP.
  const nr = s.networkRestrictions;
  if (nr) {
    const v4 = nr.config?.dbAllowedCidrs ?? [];
    const v6 = nr.config?.dbAllowedCidrsV6 ?? [];
    const all = [...v4, ...v6];
    const open = (c: string) => c === "0.0.0.0/0" || c === "::/0";
    if (all.length === 0 || all.some(open)) {
      out.push({
        severity: "med",
        category: "Security",
        title:
          all.length === 0
            ? "Database has no network restrictions (reachable from any IP)"
            : "Database network restriction allows all IPs (0.0.0.0/0)",
        anchor,
        dashUrl: dbUrl,
        evidence: `dbAllowedCidrs: ${all.join(", ") || "(none)"}`,
        ...meta("network_restrictions_open"),
      });
    }
  }

  // SSL enforcement off -> the server still accepts unencrypted connections.
  if (s.sslEnforcement && s.sslEnforcement.currentConfig.database === false) {
    out.push({
      severity: "med",
      category: "Security",
      title: "SSL enforcement is off (unencrypted DB connections accepted)",
      anchor,
      dashUrl: dbUrl,
      ...meta("ssl_not_enforced"),
    });
  }

  // The hosted security advisor (PAT mode) already reports leaked-password and
  // insufficient-MFA as catalogued lints; our GoTrue-config findings are the
  // FALLBACK for no-PAT mode (where those lints aren't fetched). Suppress the
  // overlapping ones when the advisor already fired them, so a PAT run doesn't
  // double-report (advisor MED + our LOW for the same setting).
  const secLints = new Set(a.advisors.security.map((l) => String(l.name)));
  const auth = s.auth;
  if (auth) {
    if (auth.mailer_autoconfirm === true) {
      out.push({
        severity: "med",
        category: "Security",
        title: "Email confirmation is off (signups auto-confirmed without verifying the address)",
        anchor,
        dashUrl: authUrl,
        ...meta("auth_email_autoconfirm"),
      });
    }
    // Only assert on MFA when the fields were actually present in the response.
    const mfaFields = [
      auth.mfa_totp_verify_enabled,
      auth.mfa_phone_verify_enabled,
      auth.mfa_web_authn_verify_enabled,
    ];
    if (
      mfaFields.some((v) => v !== undefined) &&
      !mfaFields.some((v) => v === true) &&
      !secLints.has("auth_insufficient_mfa_options")
    ) {
      out.push({
        severity: "low",
        category: "Security",
        title: "No MFA factor is enabled project-wide (users cannot enrol a second factor)",
        anchor,
        dashUrl: `https://supabase.com/dashboard/project/${ref}/auth/mfa`,
        ...meta("auth_mfa_disabled"),
      });
    }
    const weakLen =
      auth.password_min_length != null && auth.password_min_length < THRESHOLDS.passwordMinLength;
    // HIBP/leaked-password is the advisor's auth_leaked_password_protection lint
    // in PAT mode; only flag it ourselves when the advisor didn't (no-PAT).
    const noHibp =
      auth.password_hibp_enabled === false && !secLints.has("auth_leaked_password_protection");
    if (weakLen || noHibp) {
      const bits: string[] = [];
      if (weakLen)
        bits.push(`min length ${auth.password_min_length} (< ${THRESHOLDS.passwordMinLength})`);
      if (noHibp) bits.push("leaked-password (HIBP) check off");
      out.push({
        severity: weakLen ? "med" : "low",
        category: "Security",
        title: "Weak password policy",
        anchor,
        dashUrl: authUrl,
        evidence: bits.join("; "),
        ...meta("auth_weak_password_policy"),
      });
    }
    if (auth.external_anonymous_users_enabled === true) {
      out.push({
        severity: "low",
        category: "Security",
        title: "Anonymous sign-ins are enabled (confirm RLS + rate limits account for anon users)",
        anchor,
        dashUrl: authUrl,
        ...meta("auth_anonymous_users"),
      });
    }
    if (auth.jwt_exp != null && auth.jwt_exp > THRESHOLDS.jwtExpMaxSec) {
      out.push({
        severity: "low",
        category: "Security",
        title: `Access-token TTL is ${Math.round(auth.jwt_exp / 60)} min (> ${Math.round(THRESHOLDS.jwtExpMaxSec / 60)} min default)`,
        anchor,
        dashUrl: `https://supabase.com/dashboard/project/${ref}/auth/sessions`,
        ...meta("auth_long_jwt"),
      });
    }
  }
  return out;
}

/** Derive a ranked, deduped findings list - the pyramid apex of the report. */
/**
 * Parse a Postgres interval text ('16:31:12', '3 days 04:05:06', '1 day',
 * '2 mons 5 days') into fractional days. Returns null when absent/unparseable
 * so callers can distinguish "no window" from "zero window".
 */
export function parseIntervalDays(text: string | null | undefined): number | null {
  if (!text) return null;
  let days = 0;
  let matched = false;
  const yr = text.match(/(\d+)\s+years?/);
  if (yr?.[1]) {
    days += Number(yr[1]) * 365;
    matched = true;
  }
  const mon = text.match(/(\d+)\s+mons?/);
  if (mon?.[1]) {
    days += Number(mon[1]) * 30;
    matched = true;
  }
  const d = text.match(/(\d+)\s+days?/);
  if (d?.[1]) {
    days += Number(d[1]);
    matched = true;
  }
  const hms = text.match(/(\d{1,2}):(\d{2}):(\d{2}(?:\.\d+)?)/);
  if (hms?.[1] && hms[2] && hms[3]) {
    days += (Number(hms[1]) * 3600 + Number(hms[2]) * 60 + Number(hms[3])) / 86400;
    matched = true;
  }
  return matched ? days : null;
}

/**
 * The stats-accumulation window in days. Prefers the per-table counter reset
 * (pg_stat_database - what unused-index / dead-tuple / cache-hit signals are
 * actually relative to), falling back to the pg_stat_statements age. Null when
 * neither was collected.
 */
export function statsWindowDays(a: Analysis): number | null {
  return parseIntervalDays(a.sql.tableStatsResetAge) ?? parseIntervalDays(a.sql.statsResetAge);
}

/**
 * Low-confidence caveat string for counter-derived findings when the stats
 * window is below THRESHOLDS.minStatsWindowDays, else null. Keeps the caveat
 * text in one place and gated on the threshold (never hardcoded per finding).
 */
function shortStatsWindowCaveat(a: Analysis): string | null {
  const d = statsWindowDays(a);
  if (d == null || d >= THRESHOLDS.minStatsWindowDays) return null;
  const window = d < 1 ? `~${Math.round(d * 24)}h` : `~${d.toFixed(1)}d`;
  return `Low confidence: counters have only accumulated for ${window} (< ${THRESHOLDS.minStatsWindowDays}d); re-check after a full workload cycle before acting.`;
}

/**
 * Count depletion EPISODES in a trend series: a transition from above a
 * threshold to at/below it (a fresh dip), so a series that dips, recovers, and
 * dips again counts as 2. Turns a window-minimum into when/how-often/recovered.
 */
export function countDepletionEpisodes(points: { v: number }[], threshold: number): number {
  let episodes = 0;
  let below = false;
  for (const p of points) {
    if (p.v <= threshold) {
      if (!below) episodes++;
      below = true;
    } else {
      below = false;
    }
  }
  return episodes;
}

export function deriveFindings(a: Analysis): Finding[] {
  const out: Finding[] = [];
  const set = settingsMap(a.sql.pgSettings);
  // Which upstream advisor lints already fired. The SQL-derived unused/duplicate
  // index findings below are FALLBACKS for when advisors are unavailable (e.g.
  // the hosted advisors/performance endpoint 400s and no superuser --db-url is
  // present to run splinter): when the advisor already covers a lint, its richer
  // catalogued card wins and we must not emit a second card for the same objects.
  const advisorLints = new Set(a.advisors.performance.map((l) => String(l.name)));
  // Confidence caveat for counter-derived findings when the stats window is
  // short (counters recently reset - unused-index / cache-hit / dead-tuple
  // verdicts have not seen a full workload cycle yet). Gated on the threshold.
  const winCaveat = shortStatsWindowCaveat(a);

  // Advisors (grouped by title)
  out.push(
    ...groupAdvisors(a.advisors.performance, "Performance", "#adv-perf", a.meta.ref, winCaveat),
  );
  out.push(...groupAdvisors(a.advisors.security, "Security", "#adv-sec", a.meta.ref));

  // Performance - SQL-derived. The cache-hit ratio is only trustworthy once the
  // DB has done enough block access since stats reset; on a tiny/idle DB (e.g. a
  // 20MB project) cold-start reads dominate and a "59%" ratio is noise, so gate
  // on the access-volume floor before flagging.
  const cacheVolOk =
    a.sql.cacheBlocksAccessed == null || a.sql.cacheBlocksAccessed >= THRESHOLDS.cacheHitMinBlocks;
  if (cacheVolOk && a.sql.cacheHitPct != null && a.sql.cacheHitPct < THRESHOLDS.cacheHitPct) {
    out.push({
      severity: "med",
      category: "Performance",
      title: `Cache hit ratio ${a.sql.cacheHitPct}% (target > ${THRESHOLDS.cacheHitPct}%)`,
      anchor: "#infra",
      ...(winCaveat ? { evidence: winCaveat } : {}),
      ...meta("cache_hit_low"),
    });
  }
  // Per-query work_mem spill: a repeatedly-called query writing large temp files
  // has sorts/hashes exceeding work_mem and spilling to disk (slow + extra IOPS).
  // More actionable than the aggregate temp-file trend - it names the query.
  const spill = a.sql.queryIoStats.find(
    (r) => num(r.temp_blks_written) >= THRESHOLDS.tempSpillBlocks,
  );
  if (spill) {
    out.push({
      severity: "med",
      category: "Performance",
      title: `A query is spilling to disk (${spill.temp_written ?? "temp files"} over ${spill.calls} calls)`,
      anchor: "#queryio",
      evidence: String(spill.query ?? ""),
      ...meta("query_temp_spill"),
    });
  }
  // Latency instability: high coefficient of variation (stddev/mean) on a query
  // that isn't trivially fast - plan flips, lock waits, or cache variance make
  // its p99 much worse than its mean suggests.
  const vary = a.sql.queryIoStats.find(
    (r) => num(r.cv) >= THRESHOLDS.queryCvWarn && num(r.mean_ms) >= THRESHOLDS.queryCvMinMeanMs,
  );
  if (vary) {
    out.push({
      severity: "low",
      category: "Performance",
      title: `A query has unstable latency (${vary.cv}x variation around a ${vary.mean_ms}ms mean)`,
      anchor: "#queryio",
      evidence: String(vary.query ?? ""),
      ...meta("query_high_variance"),
    });
  }
  // FALLBACK for the advisor's auth_rls_initplan perf lint (which detects the
  // same unwrapped-auth-per-row pattern). Suppress when the advisor already
  // fired it so a PAT run (or a superuser run with splinter) never
  // double-reports; ours covers the case where advisors are unavailable.
  const unwrapped = a.sql.rlsPolicies.filter((r) => r.unwrapped_auth === true).length;
  if (unwrapped > 0 && !advisorLints.has("auth_rls_initplan")) {
    out.push({
      severity: "med",
      category: "Performance",
      title: `${unwrapped} RLS ${unwrapped === 1 ? "policy" : "policies"} re-evaluate auth per row - wrap in (select auth.*())`,
      anchor: "#rls",
      ...meta("rls_initplan"),
    });
  }
  const seqScanRows = appRows(a.sql.seqScanHeavy);
  const seqScan = seqScanRows.length;
  if (seqScan > 0) {
    out.push({
      severity: "med",
      category: "Performance",
      title: `${countCapped(seqScanRows.length, seqScan)} ${seqScan === 1 ? "table" : "tables"} sequential-scan heavy (missing index?)`,
      anchor: "#seqscan",
      ...meta("seq_scan_heavy"),
    });
  }
  // Suppress when the advisor's own `unused_index` lint already covers it, else
  // the same indexes are reported twice (advisor card + this fallback).
  const unused = appRows(a.sql.indexStats).filter((r) => r.unused === true).length;
  if (unused > 0 && !advisorLints.has("unused_index")) {
    out.push({
      severity: "low",
      category: "Performance",
      title: `${unused} unused ${unused === 1 ? "index" : "indexes"} (write overhead)`,
      anchor: "#unused",
      ...(winCaveat ? { evidence: winCaveat } : {}),
      ...meta("unused_index"),
    });
  }
  const dupIdx = appRows(a.sql.duplicateIndexes).length;
  if (dupIdx > 0 && !advisorLints.has("duplicate_index")) {
    out.push({
      severity: "med",
      category: "Performance",
      title: `${dupIdx} ${dupIdx === 1 ? "table has" : "tables have"} duplicate indexes (drop the copies)`,
      anchor: "#dupidx",
      ...meta("duplicate_index"),
    });
  }
  // Foreign keys with no covering index (slow cascades + lock escalation).
  // Suppress when the advisor's unindexed_foreign_keys lint already covers it.
  const fkUnindexed = appRows(a.sql.fkUnindexed).length;
  if (fkUnindexed > 0 && !advisorLints.has("unindexed_foreign_keys")) {
    out.push({
      severity: "med",
      category: "Performance",
      title: `${countCapped(a.sql.fkUnindexed.length, fkUnindexed, 30)} foreign ${fkUnindexed === 1 ? "key lacks" : "keys lack"} a covering index`,
      anchor: "#fkunindexed",
      ...meta("fk_unindexed"),
    });
  }
  // Invalid / not-ready indexes (failed CONCURRENTLY builds).
  const invalidIdx = appRows(a.sql.invalidIndexes).length;
  if (invalidIdx > 0) {
    out.push({
      severity: "med",
      category: "Performance",
      title: `${invalidIdx} invalid ${invalidIdx === 1 ? "index" : "indexes"} (failed build - drop + rebuild)`,
      anchor: "#invalididx",
      ...meta("invalid_index"),
    });
  }
  // Large tables with a low all-visible page fraction (index-only-scan limited).
  const lowVis = appRows(a.sql.visibilityMap).length;
  if (lowVis > 0) {
    out.push({
      severity: "low",
      category: "Performance",
      title: `${countCapped(a.sql.visibilityMap.length, lowVis)} large ${lowVis === 1 ? "table has" : "tables have"} a low all-visible ratio (index-only scans limited; vacuum behind)`,
      anchor: "#visibilitymap",
      ...meta("visibility_map_low"),
    });
  }
  // PUBLIC can CREATE in schema public (privilege-escalation surface).
  if (a.sql.publicSchemaCreate.some((r) => r.public_create === true)) {
    out.push({
      severity: "med",
      category: "Security",
      title: "PUBLIC can CREATE objects in schema public",
      anchor: "#seccfg",
      ...meta("public_schema_create"),
    });
  }
  // Top WAL-generating statement (write-amplification hotspot).
  const walTop = a.sql.topByWal[0];
  if (walTop && num(walTop.pct_wal) >= THRESHOLDS.walHeavyPct) {
    out.push({
      severity: "low",
      category: "Capacity",
      title: `One statement generates ${num(walTop.pct_wal)}% of WAL (${String(walTop.wal ?? "")})`,
      anchor: "#walbystatement",
      evidence: `${walTop.calls ? `${Number(walTop.calls).toLocaleString()} calls. ` : ""}WAL drives replication lag, backup size, and pg_wal growth.`,
      ...meta("wal_heavy_statement"),
    });
  }
  const rlsUnindexed = appRows(a.sql.rlsUnindexed).length;
  if (rlsUnindexed > 0) {
    out.push({
      severity: "med",
      category: "Performance",
      title: `${rlsUnindexed} RLS policy ${rlsUnindexed === 1 ? "column" : "columns"} lack a covering index (seq scan per check)`,
      anchor: "#rlsunindexed",
      ...meta("rls_col_unindexed"),
    });
  }
  if (
    a.upgrade?.current_app_version &&
    a.upgrade.latest_app_version &&
    a.upgrade.current_app_version !== a.upgrade.latest_app_version
  ) {
    // The GitHub release tag is the bare version (e.g. 17.6.1.141); the API
    // reports it prefixed (supabase-postgres-17.6.1.141). Extract the version
    // and link the release notes so the reader sees what the update carries.
    const ver = a.upgrade.latest_app_version.match(/\d+(?:\.\d+)+/)?.[0];
    out.push({
      severity: "low",
      category: "Performance",
      title: `Postgres update available (${a.upgrade.current_app_version} -> ${a.upgrade.latest_app_version})`,
      anchor: "#infra",
      ...meta("pg_update_available"),
      ...(ver ? { changelogUrl: `https://github.com/supabase/postgres/releases/tag/${ver}` } : {}),
    });
  }
  if (set.get("idle_in_transaction_session_timeout") === "0") {
    out.push({
      severity: "low",
      category: "Performance",
      title: "idle_in_transaction_session_timeout disabled (idle txns can block autovacuum)",
      anchor: "#config",
      ...meta("idle_in_txn_timeout_off"),
    });
  }
  if (set.get("statement_timeout") === "0") {
    out.push({
      severity: "low",
      category: "Performance",
      title: "statement_timeout disabled (runaway queries not capped)",
      anchor: "#config",
      ...meta("statement_timeout_off"),
    });
  }

  // Capacity
  const conns = a.sql.connections.reduce((s, r) => s + num(r.connections), 0);
  const maxConn = num(set.get("max_connections"));
  if (maxConn > 0 && conns / maxConn >= THRESHOLDS.directConnFrac) {
    out.push({
      severity: "med",
      category: "Capacity",
      title: `Direct connections at ${Math.round((conns / maxConn) * 100)}% of max (${conns}/${maxConn})`,
      anchor: "#connections",
      ...meta("direct_conn_high"),
    });
  }
  if (a.disk?.usedBytes != null && a.disk.availBytes != null) {
    const total = a.disk.usedBytes + a.disk.availBytes;
    if (total > 0 && a.disk.usedBytes / total >= THRESHOLDS.diskFullFrac) {
      out.push({
        severity: "med",
        category: "Capacity",
        title: `Disk ${Math.round((a.disk.usedBytes / total) * 100)}% full`,
        anchor: "#infra",
        ...meta("disk_full"),
      });
    } else if (a.disk.sizeGb != null && a.disk.sizeGb > 0) {
      // Over-provisioned volume (downsize candidate): filesystem used well below
      // the provisioned size, with meaningful absolute waste. The disk analogue
      // of cpu_oversized. Reclaimable (bloat + droppable unused indexes + WAL
      // dir + retained slot WAL) refines the "true footprint" the report shows.
      const provisioned = a.disk.sizeGb * 1024 * 1024 * 1024;
      const usedFrac = a.disk.usedBytes / provisioned;
      const wasteGb = (provisioned - a.disk.usedBytes) / (1024 * 1024 * 1024);
      if (
        usedFrac <= THRESHOLDS.diskOversizeUsedFrac &&
        wasteGb >= THRESHOLDS.diskOversizeMinWasteGb
      ) {
        const reclaimableBytes = reclaimableDiskBytes(a);
        const footprintGb = Math.max(
          0,
          (a.disk.usedBytes - reclaimableBytes) / (1024 * 1024 * 1024),
        );
        const reclaimNote =
          reclaimableBytes > 0
            ? ` ~${bytesGb(reclaimableBytes)} is reclaimable (bloat, unused indexes, slot-pinned WAL), so the true footprint is ~${footprintGb.toFixed(1)} GB.`
            : "";
        out.push({
          severity: "low",
          category: "Capacity",
          title: `Disk over-provisioned: ${a.disk.sizeGb} GB volume, ${Math.round(usedFrac * 100)}% used (${bytesGb(a.disk.usedBytes)})`,
          anchor: "#infra",
          evidence: `~${wasteGb.toFixed(0)} GB unused.${reclaimNote}${a.disk.autoscale ? " Autoscale is grow-only - it will not shrink this back." : ""}${a.disk.modifiable === false ? " NOTE: this org's plan cannot modify disk without a compute upgrade." : ""}`,
          ...meta("disk_oversized"),
        });
      }
    }
  }
  const overdue = a.sql.deadTuples.filter((r) => r.overdue === "yes").length;
  if (overdue > 0) {
    out.push({
      severity: "med",
      category: "Capacity",
      title: `${countCapped(a.sql.deadTuples.length, overdue)} ${overdue === 1 ? "table" : "tables"} past the autovacuum dead-tuple threshold (vacuum not keeping up)`,
      anchor: "#deadtuples",
      ...(winCaveat ? { evidence: winCaveat } : {}),
      ...meta("autovacuum_overdue"),
    });
  }
  // Tables never (auto)vacuumed - no visibility map / stats maintenance.
  const neverVac = appRows(a.sql.neverVacuumed).length;
  if (neverVac > 0) {
    out.push({
      severity: "low",
      category: "Capacity",
      title: `${countCapped(a.sql.neverVacuumed.length, neverVac)} ${neverVac === 1 ? "table has" : "tables have"} never been vacuumed (stale stats / no visibility map)`,
      anchor: "#nevervacuumed",
      ...meta("never_autovacuumed"),
    });
  }
  // Per-role connection exhaustion (a single role burning its own budget).
  for (const r of a.sql.roleStats) {
    const conns = num(r.connections);
    const limit = num(r.conn_limit);
    if (limit > 0 && conns / limit >= THRESHOLDS.roleConnFrac) {
      out.push({
        severity: "med",
        category: "Capacity",
        title: `Role ${String(r.role)} at ${Math.round((conns / limit) * 100)}% of its connection limit (${conns}/${limit})`,
        anchor: "#roles",
        ...meta("role_conn_high"),
      });
    }
  }
  // Transaction-ID wraparound headroom (age(relfrozenxid) toward the 2B ceiling).
  const maxXidPct = a.sql.txidWraparound.reduce((mx, r) => Math.max(mx, num(r.pct_wraparound)), 0);
  if (maxXidPct >= THRESHOLDS.txidWarnPct) {
    out.push({
      severity: maxXidPct >= THRESHOLDS.txidHighPct ? "high" : "med",
      category: "Capacity",
      title: `Transaction-ID wraparound at ${maxXidPct}% on the oldest table (freeze autovacuum falling behind)`,
      anchor: "#txid",
      ...meta("txid_wraparound"),
    });
  }
  // Multixact-ID wraparound headroom (relminmxid toward its own 2B ceiling).
  const maxMxidPct = a.sql.multixactWraparound.reduce(
    (mx, r) => Math.max(mx, num(r.pct_wraparound)),
    0,
  );
  if (maxMxidPct >= THRESHOLDS.txidWarnPct) {
    out.push({
      severity: maxMxidPct >= THRESHOLDS.txidHighPct ? "high" : "med",
      category: "Capacity",
      title: `Multixact-ID wraparound at ${maxMxidPct}% on the oldest table (heavy row locking; freeze falling behind)`,
      anchor: "#multixact",
      ...meta("multixact_wraparound"),
    });
  }
  // Replication slots: inactive slots pin WAL (disk-fill risk); large active lag
  // signals a slow downstream consumer.
  const inactiveSlots = a.sql.replicationSlots.filter(
    (r) => r.active === false && num(r.retained_wal_bytes) > 0,
  ).length;
  if (inactiveSlots > 0) {
    out.push({
      severity: "high",
      category: "Capacity",
      title: `${inactiveSlots} inactive replication ${inactiveSlots === 1 ? "slot" : "slots"} retaining WAL (pins disk until dropped)`,
      anchor: "#slots",
      ...meta("wal_retained_inactive_slot"),
    });
  }
  const laggingSlots = a.sql.replicationSlots.filter(
    (r) => r.active === true && num(r.retained_wal_bytes) >= THRESHOLDS.slotLagBytes,
  ).length;
  if (laggingSlots > 0) {
    out.push({
      severity: "med",
      category: "Capacity",
      title: `${laggingSlots} replication ${laggingSlots === 1 ? "slot" : "slots"} lagging >1GB WAL (slow consumer)`,
      anchor: "#slots",
      ...meta("wal_slot_lag"),
    });
  }
  // Reclaimable bloat. Prefer MEASURED pgstattuple(_approx) bytes when present
  // (superuser + extension installed); otherwise the pg_stats ESTIMATE, clearly
  // labelled as an estimate to verify. Either way, annotate with the likely
  // churn source when a high-frequency write targets the table.
  const writes = writeTargets(a);
  const churnNote = (tableName: string): string | undefined => {
    const seg = tableName.split(".").pop() ?? tableName;
    const w = writes.get(seg);
    return w && w.calls >= THRESHOLDS.hotWriteMinCalls
      ? `Likely churn-driven: ${w.calls.toLocaleString()} ${w.kind} calls target this table.`
      : undefined;
  };
  const exactBloat = a.sql.bloatExact
    .map((r) => ({
      name: String(r.name),
      bytes: num(r.reclaimable_bytes),
      pretty: String(r.reclaimable ?? ""),
    }))
    .filter((r) => r.bytes > 0)
    .sort((x, y) => y.bytes - x.bytes)[0];
  if (exactBloat && exactBloat.bytes >= THRESHOLDS.bloatMinBytes) {
    out.push({
      severity: exactBloat.bytes >= THRESHOLDS.bloatMedBytes ? "med" : "low",
      category: "Capacity",
      title: `~${exactBloat.pretty} reclaimable on ${exactBloat.name} (measured via pgstattuple; pg_repack)`,
      anchor: "#bloat",
      evidence: churnNote(exactBloat.name),
      ...meta("table_bloat"),
    });
  } else {
    const worstBloat = a.sql.bloat.reduce((mx, r) => Math.max(mx, num(r.waste_bytes)), 0);
    if (worstBloat >= THRESHOLDS.bloatMinBytes) {
      const top = a.sql.bloat.find((r) => num(r.waste_bytes) === worstBloat);
      const name = String(top?.name ?? "a table");
      out.push({
        severity: worstBloat >= THRESHOLDS.bloatMedBytes ? "med" : "low",
        category: "Capacity",
        title: `~${String(top?.waste ?? "")} estimated reclaimable bloat on ${name} (pg_stats estimate - verify, then pg_repack)`,
        anchor: "#bloat",
        evidence: churnNote(name),
        ...meta("table_bloat"),
      });
    }
  }
  // Cold TOAST cache: a table whose out-of-line (TOAST) column is being re-read
  // from disk on nearly every access (low toast hit-ratio + meaningful read
  // volume). The per-relation reason a DB is IO-bound that the global cache-hit
  // ratio hides - classic for large JSON/blob and high-dimension vector columns.
  // Ordered by disk reads (query already), so [0] is the worst; one finding is
  // enough (the per-table I/O drill lists the rest).
  const coldToast = a.sql.tableIoStats
    .filter(
      (r) =>
        num(r.toast_blks_read) >= THRESHOLDS.toastColdMinReadBlocks &&
        r.toast_hit_pct != null &&
        num(r.toast_hit_pct) <= THRESHOLDS.toastColdHitPct,
    )
    .sort((x, y) => num(y.toast_blks_read) - num(x.toast_blks_read));
  if (coldToast[0]) {
    const r = coldToast[0];
    const mb = Math.round((num(r.toast_blks_read) * 8) / 1024);
    out.push({
      severity: "med",
      category: "Performance",
      title: `${String(r.table)} is I/O-bound de-toasting (TOAST cache hit ${num(r.toast_hit_pct)}%)`,
      anchor: "#tableio",
      evidence: `~${mb.toLocaleString()} MB read from its TOAST relation off disk since stats reset - the out-of-line column can't stay cached, so each scan re-fetches it.`,
      ...meta("toast_cache_cold"),
    });
  }
  // Storage attribution: name the table that dominates disk, as a share of the
  // whole database. Answers "what is filling the disk" - which the biggest-
  // tables drill has, but no finding surfaced. Needs the byte columns + db size.
  const dbBytes = a.sql.dbSizeBytes ?? 0;
  const topTable = a.sql.biggestTables[0];
  if (topTable && dbBytes > 0 && num(topTable.total_bytes) > 0) {
    const share = num(topTable.total_bytes) / dbBytes;
    if (share >= THRESHOLDS.storageConcentrationFrac) {
      const idxShare = num(topTable.index_bytes) / num(topTable.total_bytes);
      out.push({
        severity: "low",
        category: "Capacity",
        title: `${String(topTable.table)} is ${Math.round(share * 100)}% of the database (${String(topTable.total_size)} of ${String(a.sql.dbSize ?? "")})`,
        anchor: "#tables",
        evidence: `${String(topTable.index_size)} of it is indexes (${Math.round(idxShare * 100)}%); ${String(topTable.live_rows ?? "?")} live rows.`,
        ...meta("storage_concentration"),
      });
    }
  }
  // Stale table statistics: a table reporting 0 live rows while occupying real
  // disk means its pg_stat counters were reset (size + pg_statistic survive a
  // reset), so every counter-derived signal for it is blind. This is a data
  // CONTRADICTION, not emptiness - worth surfacing before trusting the numbers.
  const staleTables = a.sql.biggestTables.filter(
    (r) => num(r.live_rows) === 0 && num(r.total_bytes) >= THRESHOLDS.staleStatsMinBytes,
  );
  if (staleTables.length > 0) {
    const worst = staleTables[0] as SqlRow;
    out.push({
      severity: "low",
      category: "Performance",
      title: `Table statistics look stale (${staleTables.length} ${staleTables.length === 1 ? "table shows" : "tables show"} 0 live rows but hold data)`,
      anchor: "#tables",
      evidence: `Largest: ${String(worst.table)} at ${String(worst.total_size)} with 0 reported live rows - pg_stat counters were likely reset recently.`,
      ...meta("stale_table_stats"),
    });
  }
  // Index-heavy large tables: indexes rivalling the heap = disk + write cost.
  // Capped to the worst few by absolute index size so a wide schema can't
  // produce a wall of low findings; the drill-down still lists every table.
  const indexHeavy = a.sql.biggestTables
    .filter(
      (r) =>
        num(r.total_bytes) >= THRESHOLDS.indexHeavyMinBytes &&
        num(r.index_bytes) / num(r.total_bytes) >= THRESHOLDS.indexHeavyFrac,
    )
    .sort((x, y) => num(y.index_bytes) - num(x.index_bytes))
    .slice(0, THRESHOLDS.indexHeavyMaxFindings);
  for (const r of indexHeavy) {
    const total = num(r.total_bytes);
    const idx = num(r.index_bytes);
    out.push({
      severity: "low",
      category: "Capacity",
      title: `${String(r.table)} is index-heavy: ${String(r.index_size)} of indexes on a ${String(r.total_size)} table (${Math.round((idx / total) * 100)}%)`,
      anchor: "#tables",
      ...meta("index_heavy_table"),
    });
  }
  // Point-in-time: a blocking chain exists right now (real even as a snapshot).
  if (a.sql.blocking.length > 0) {
    out.push({
      severity: "high",
      category: "Performance",
      title: `${a.sql.blocking.length} blocking lock ${a.sql.blocking.length === 1 ? "chain" : "chains"} at collection time`,
      anchor: "#blocking",
      ...meta("blocking_locks"),
    });
  }
  // Point-in-time: a backend sitting idle-in-transaction. Distinct from the
  // idle_in_txn_timeout_off config finding (which flags the missing guardrail) -
  // this catches a transaction actually held open right now, which pins locks +
  // the xmin horizon (blocks autovacuum) and drives bloat. The connections plane
  // groups by state and carries the oldest state age.
  const iit = a.sql.connections.find((r) =>
    String(r.state ?? "").startsWith("idle in transaction"),
  );
  if (iit && num(iit.max_state_age_s) >= THRESHOLDS.idleInTxnAgeS) {
    const mins = Math.round(num(iit.max_state_age_s) / 60);
    out.push({
      severity: "med",
      category: "Performance",
      title: `Idle-in-transaction backend open ${mins} min (pins locks + blocks autovacuum)`,
      anchor: "#connections",
      ...meta("idle_in_txn_open"),
    });
  }
  // Point-in-time: queries running > 5 minutes at collection time.
  if (a.sql.longRunning.length > 0) {
    out.push({
      severity: "med",
      category: "Performance",
      title: `${a.sql.longRunning.length} quer${a.sql.longRunning.length === 1 ? "y" : "ies"} running > 5 min at collection time`,
      anchor: "#longrunning",
      ...meta("long_running"),
    });
  }
  // Edge-function server-error rate (from functions.combined-stats).
  for (const fn of a.functionStats) {
    if (
      fn.requests >= THRESHOLDS.fnMinRequests &&
      fn.serverErr / fn.requests >= THRESHOLDS.fnErrWarnFrac
    ) {
      const pct = Math.round((fn.serverErr / fn.requests) * 100);
      out.push({
        severity: fn.serverErr / fn.requests >= THRESHOLDS.fnErrHighFrac ? "high" : "med",
        category: "Performance",
        title: `Edge function ${fn.slug}: ${pct}% 5xx over ${fn.requests} requests`,
        anchor: "#functions",
        ...meta("fn_5xx"),
      });
    }
  }
  const latestTrend = (title: string) =>
    a.trends.find((t) => t.title === title)?.points.at(-1)?.v ?? 0;
  // Mean over the trend window - a "sustained" signal, robust to a single-point
  // lull/spike (unlike latestTrend, which is the last point only).
  const avgTrend = (title: string) => {
    const pts = a.trends.find((t) => t.title === title)?.points ?? [];
    return pts.length ? pts.reduce((sum, p) => sum + p.v, 0) / pts.length : 0;
  };
  const maxMetric = (name: string) =>
    a.metrics.samples.filter((s) => s.name === name).reduce((mx, s) => Math.max(mx, s.value), 0);
  const sumMetric = (name: string) =>
    a.metrics.samples.filter((s) => s.name === name).reduce((sum, s) => sum + s.value, 0);
  const waiting = maxMetric("pgbouncer_pools_client_waiting_connections");
  if (waiting > 0) {
    out.push({
      severity: "med",
      category: "Capacity",
      title: `${waiting} client${waiting === 1 ? "" : "s"} waiting on the pooler`,
      anchor: "#metrics",
      ...meta("pooler_clients_waiting"),
    });
  }
  // Memory pressure from sustained PAGING (rate; needs >=2 snapshots / a
  // Prometheus). Deliberately NOT swap occupancy: swap is tiny (~1GB) and the
  // kernel parks cold anon pages there, so a full-but-idle swap is normal. The
  // real signal is a sustained swap-IN or major-fault RATE - the working set
  // spilling out of RAM to disk - which a MemAvailable snapshot cannot see.
  const majorFaults = avgTrend("Major page faults/s");
  const swapIn = avgTrend("Swap-in pages/s");
  if (majorFaults >= THRESHOLDS.majorFaultsPerSec || swapIn >= THRESHOLDS.swapInPagesPerSec) {
    const bits: string[] = [];
    if (majorFaults >= THRESHOLDS.majorFaultsPerSec)
      bits.push(`${Math.round(majorFaults)} major faults/s`);
    if (swapIn >= THRESHOLDS.swapInPagesPerSec) bits.push(`${Math.round(swapIn)} swap-ins/s`);
    out.push({
      severity: "med",
      category: "Capacity",
      title: `Memory pressure: working set paging to disk (${bits.join(", ")})`,
      anchor: "#trends",
      ...meta("mem_pressure_paging"),
    });
  }
  // PSI saturation: sustained stall time waiting on CPU / memory / I/O (rate;
  // needs >=2 snapshots / a Prometheus). PSI is the fraction of time work was
  // stalled for a resource - a truer saturation signal than a utilization
  // snapshot, and it names WHICH resource is the bottleneck.
  const stalled = (
    [
      ["CPU stall (PSI %)", "CPU"],
      ["Memory stall (PSI %)", "memory"],
      ["I/O stall (PSI %)", "I/O"],
    ] as const
  )
    .map(([title, label]) => [avgTrend(title), label] as const)
    .filter(([v]) => v >= THRESHOLDS.psiStallPct);
  if (stalled.length) {
    const bits = stalled.map(([v, label]) => `${label} ${Math.round(v)}%`);
    out.push({
      severity: "med",
      category: "Capacity",
      title: `Resource saturation: sustained stall time (${bits.join(", ")})`,
      anchor: "#trends",
      ...meta("psi_saturation"),
    });
  }
  // OOM kills: the kernel OOM killer fired - memory was genuinely exhausted and
  // a process was killed. Any nonzero rate over the window means kills happened.
  const oomKills = avgTrend("OOM kills/s");
  if (oomKills > 0) {
    out.push({
      severity: "high",
      category: "Capacity",
      title: "OOM killer fired (out-of-memory process kills)",
      anchor: "#trends",
      ...meta("oom_kill"),
    });
  }
  // EBS burst-balance depletion: gp2/gp3 throttle hard when credits run down.
  // Framed EPISODICALLY, not present-tense: the window MINIMUM hitting 0% may
  // be a scar that already recovered, so a bare "depleting (0%)" misreads a past
  // incident as an active one. Report when/how-often/current instead. Only
  // evaluate when the series exists - an absent series is NOT 0% balance.
  const ebsEpisodic = (
    [
      ["EBS IOPS balance (%)", "IOPS"],
      ["EBS throughput balance (%)", "throughput"],
    ] as const
  )
    .map(([title, label]) => ({
      label,
      pts: a.trends.find((t) => t.title === title)?.points ?? [],
    }))
    .filter(({ pts }) => pts.length > 0)
    .map(({ label, pts }) => {
      const last = pts[pts.length - 1] as { t: number; v: number };
      const lastDip = [...pts].reverse().find((p) => p.v <= THRESHOLDS.ebsBalancePct);
      const spanDays = pts.length > 1 ? (last.t - (pts[0] as { t: number }).t) / 86400 : 0;
      return {
        label,
        episodes: countDepletionEpisodes(pts, THRESHOLDS.ebsBalancePct),
        current: last.v,
        lastDipT: lastDip?.t ?? null,
        spanDays,
      };
    })
    .filter((s) => s.episodes > 0);
  if (ebsEpisodic.length) {
    const currentlyLow = ebsEpisodic.some((s) => s.current <= THRESHOLDS.ebsBalancePct);
    const maxEpisodes = Math.max(...ebsEpisodic.map((s) => s.episodes));
    const span = Math.round(Math.max(...ebsEpisodic.map((s) => s.spanDays)));
    const bits = ebsEpisodic.map((s) => {
      const when = s.lastDipT ? new Date(s.lastDipT * 1000).toISOString().slice(0, 10) : "?";
      const times = `${s.episodes}x${span ? ` in ${span}d` : ""}`;
      return `${s.label} depleted ${times} (last ${when}, currently ${Math.round(s.current)}%)`;
    });
    out.push({
      // High only if it is depleted RIGHT NOW or recurred (>=2 episodes); a
      // single healed dip is a scar, not an active incident -> medium.
      severity: currentlyLow || maxEpisodes >= 2 ? "high" : "med",
      category: "Capacity",
      title: `EBS burst balance: ${bits.join("; ")}`,
      anchor: "#trends",
      ...meta("ebs_balance_low"),
    });
  }
  // Deadlocks (cumulative counter since stats reset). A rate from >=2 snapshots
  // is stronger, but a nonzero cumulative count is still worth a glance.
  const deadlocks = Math.round(sumMetric("pg_stat_database_deadlocks_total"));
  if (deadlocks >= THRESHOLDS.deadlockMin) {
    out.push({
      severity: "low",
      category: "Performance",
      title: `${deadlocks} deadlocks recorded (cumulative since stats reset)`,
      anchor: "#metrics",
      ...meta("deadlocks"),
    });
  }
  // work_mem spill: sustained temp-file write rate (needs >=2 snapshots).
  const tempRate = latestTrend("Temp file bytes/s");
  if (tempRate >= THRESHOLDS.tempSpillBytesPerSec) {
    out.push({
      severity: "med",
      category: "Performance",
      title: "Sorts/hashes spilling to disk (raise work_mem)",
      anchor: "#trends",
      ...meta("work_mem_spill"),
    });
  }
  // Realtime postgres_changes nudge: it does not scale like Broadcast.
  const pgChanges = Math.round(sumMetric("realtime_postgres_changes_total_subscriptions"));
  if (pgChanges > 0) {
    out.push({
      severity: "low",
      category: "Performance",
      title: `postgres_changes has ${pgChanges} active subscription${pgChanges === 1 ? "" : "s"} (consider Broadcast for scale)`,
      anchor: "#metrics",
      ...meta("realtime_postgres_changes"),
    });
  }
  // Disk IOPS headroom (needs a Prometheus scraper for the rate; trends-derived).
  const iops = latestTrend("Disk read IOPS") + latestTrend("Disk write IOPS");
  if (a.disk?.iops && iops >= a.disk.iops * THRESHOLDS.diskIopsFrac) {
    out.push({
      severity: "med",
      category: "Capacity",
      title: `Disk IOPS at ${Math.round((iops / a.disk.iops) * 100)}% of provisioned (${Math.round(iops)}/${a.disk.iops})`,
      anchor: "#trends",
      ...meta("disk_iops_high"),
    });
  }

  // --- Trend-driven capacity findings (data-aware) --------------------------
  // These read the 30/90-day series via trendstats. Each is gated by
  // sufficient() so it NEVER fires from a single snapshot - it lights up when a
  // Grafana source gives real history (or enough store snapshots accrue). This
  // is where the no-PAT + Grafana path earns its keep: the Management-API
  // provisioning planes are gone, so the trend IS the capacity signal.
  const pointsOf = (title: string) => a.trends.find((t) => t.title === title)?.points ?? [];

  // Replication-slot WAL retention CLIMBING (trend; store path only). An active
  // slot whose retained WAL keeps rising = the consumer is falling behind, a
  // disk-fill risk the point-in-time 1 GiB threshold misses while it is still
  // under a gig (the "396 MB and growing" case). Suppressed when the absolute
  // point-in-time lag finding already fired (that stronger signal wins), and
  // gated by sufficient() so a thin store never fires it.
  const slotWalPts = pointsOf("Slot WAL retained (max, bytes)");
  const slotLagFired = a.sql.replicationSlots.some(
    (r) => r.active === true && num(r.retained_wal_bytes) >= THRESHOLDS.slotLagBytes,
  );
  if (!slotLagFired && sufficient(slotWalPts)) {
    const s = trendStat(slotWalPts)!;
    if (s.direction === "rising" && s.slopePerDay >= THRESHOLDS.slotWalGrowthMinBytesPerDay) {
      const perDay =
        s.slopePerDay >= 1024 ** 3
          ? `${(s.slopePerDay / 1024 ** 3).toFixed(1)} GB/day`
          : `${Math.round(s.slopePerDay / (1024 * 1024))} MB/day`;
      out.push({
        severity: "med",
        category: "Capacity",
        title: `Replication slot WAL retention climbing (~${perDay}, now ${bytesGb(s.fittedLast)})`,
        anchor: "#slots",
        ...meta("wal_slot_growing"),
      });
    }
  }

  // CPU sizing, both directions.
  const cpuPts = pointsOf("CPU utilization (%)");
  if (sufficient(cpuPts)) {
    const s = trendStat(cpuPts)!;
    const hotFrac = sustainedFrac(cpuPts, THRESHOLDS.cpuSustainedHighPct, ">=");
    if (hotFrac >= THRESHOLDS.cpuSustainedFrac) {
      out.push({
        severity: "high",
        category: "Capacity",
        title: `CPU sustained high: ${Math.round(hotFrac * 100)}% of ${Math.round(s.spanDays)}d at >=${THRESHOLDS.cpuSustainedHighPct}% (avg ${Math.round(s.mean)}%, peak ${Math.round(s.max)}%)`,
        anchor: "#trends",
        ...meta("cpu_saturated"),
      });
    } else if (s.spanDays >= THRESHOLDS.cpuOversizeMinDays && s.p95 <= THRESHOLDS.cpuOversizePct) {
      out.push({
        severity: "low",
        category: "Capacity",
        title: `CPU consistently idle: p95 ${Math.round(s.p95)}% over ${Math.round(s.spanDays)}d (peak ${Math.round(s.max)}%) - likely over-provisioned`,
        anchor: "#trends",
        ...meta("cpu_oversized"),
      });
    }
  }

  // Memory sustained near the ceiling.
  const memPts = pointsOf("Memory used (%)");
  if (sufficient(memPts)) {
    const s = trendStat(memPts)!;
    const frac = sustainedFrac(memPts, THRESHOLDS.memSustainedHighPct, ">=");
    if (frac >= THRESHOLDS.memSustainedFrac) {
      out.push({
        severity: "med",
        category: "Capacity",
        title: `Memory sustained high: ${Math.round(frac * 100)}% of ${Math.round(s.spanDays)}d at >=${THRESHOLDS.memSustainedHighPct}% (avg ${Math.round(s.mean)}%, peak ${Math.round(s.max)}%)`,
        anchor: "#trends",
        ...meta("mem_saturated"),
      });
    }
  }

  // Disk fill projection - rising used% -> days to full, capped to a horizon we
  // can actually see (~3x the observed span) so we never extrapolate a
  // far-future date off a short history. Checks BOTH the data disk (/data, where
  // the DB grows) and the root FS (/) - either filling takes the box down.
  for (const [title, label] of [
    ["Disk used (%)", "Data disk"],
    ["Root FS used (%)", "Root FS"],
  ] as const) {
    const pts = pointsOf(title);
    if (!sufficient(pts)) continue;
    const s = trendStat(pts)!;
    if (s.direction !== "rising") continue;
    const daysToFull = projectDaysTo(s, 100);
    const trustHorizon = Math.min(THRESHOLDS.diskFillHorizonDays, 3 * s.spanDays);
    if (daysToFull != null && daysToFull <= trustHorizon) {
      out.push({
        severity: daysToFull <= 30 ? "high" : "med",
        category: "Capacity",
        title: `${label} filling: ${Math.round(s.last)}% used, +${s.slopePerDay.toFixed(2)}%/day over ${Math.round(s.spanDays)}d -> ~${Math.round(daysToFull)} days to full`,
        anchor: "#trends",
        ...meta("disk_fill_projection"),
      });
    }
  }

  // Checkpoint pressure: share of checkpoints forced by WAL filling (requested)
  // vs the healthy timed interval. High requested share -> raise max_wal_size.
  const reqPts = pointsOf("Requested checkpoints/s");
  const timedPts = pointsOf("Timed checkpoints/s");
  if (sufficient(reqPts) && sufficient(timedPts)) {
    const req = trendStat(reqPts)!.mean;
    const timed = trendStat(timedPts)!.mean;
    const total = req + timed;
    if (total > 0 && req / total >= THRESHOLDS.checkpointReqFrac) {
      out.push({
        severity: "med",
        category: "Performance",
        title: `Checkpoint pressure: ${Math.round((req / total) * 100)}% of checkpoints forced by WAL filling (raise max_wal_size)`,
        anchor: "#trends",
        ...meta("checkpoint_pressure"),
      });
    }
  }

  // WAL archival backlog: sustained pending-archival files -> PITR/backup risk.
  const walPts = pointsOf("WAL files pending archival");
  if (sufficient(walPts)) {
    const s = trendStat(walPts)!;
    if (s.mean >= THRESHOLDS.walPendingMax) {
      out.push({
        severity: "high",
        category: "Capacity",
        title: `WAL archival falling behind: avg ${Math.round(s.mean)} files pending over ${Math.round(s.spanDays)}d (peak ${Math.round(s.max)})`,
        anchor: "#trends",
        ...meta("wal_archival_backlog"),
      });
    }
  }

  // Connection ceiling: peak backends vs max_connections (from pgSettings SQL,
  // so it works in no-PAT too). Needs both the trend and the setting.
  const connPts = pointsOf("DB connections");
  const maxConnections = num(settingsMap(a.sql.pgSettings).get("max_connections"));
  if (sufficient(connPts) && maxConnections > 0) {
    const peak = trendStat(connPts)!.max;
    if (peak >= maxConnections * THRESHOLDS.connCeilingFrac) {
      out.push({
        severity: "high",
        category: "Capacity",
        title: `Connections near ceiling: peaked ${Math.round(peak)}/${maxConnections} (${Math.round((peak / maxConnections) * 100)}% of max_connections)`,
        anchor: "#trends",
        ...meta("connections_ceiling"),
      });
    }
  }

  // Extension health (SQL-derived; works in both the PAT read-only and
  // superuser tiers, so it complements the splinter/advisor extension lints).
  const outdatedExts = a.sql.extensions.filter((r) => r.outdated === true);
  if (outdatedExts.length) {
    out.push({
      severity: "low",
      category: "Performance",
      title: `${outdatedExts.length} extension${outdatedExts.length === 1 ? "" : "s"} behind the latest available version`,
      anchor: "#extensions",
      evidence: outdatedExts.map((r) => `${r.name} ${r.installed}->${r.latest}`).join(", "),
      ...meta("extensions_outdated"),
    });
  }
  if (a.sql.unindexedVectors.length) {
    const v = a.sql.unindexedVectors;
    // Flag the ones stored out-of-line (TOAST): those exact scans also de-toast
    // from disk, not just scan the heap - the compounded large-vector IO trap.
    const outOfLine = v.filter((r) => r.out_of_line === true);
    const detail = v
      .slice(0, 5)
      .map((r) => {
        const base = `${r.schema}.${r.table}.${r.column}`;
        if (r.dimensions == null) return base;
        return `${base} (${r.dimensions}d${r.out_of_line === true ? ", TOASTed" : ""})`;
      })
      .join(", ");
    out.push({
      severity: "med",
      category: "Performance",
      title: `${v.length} pgvector column${v.length === 1 ? "" : "s"} without an ANN index (ivfflat/hnsw)`,
      anchor: "#extensions",
      evidence: outOfLine.length
        ? `${detail}. ${outOfLine.length} stored out-of-line (TOAST) - exact scans also de-toast from disk, compounding the cost.`
        : detail,
      ...meta("pgvector_unindexed"),
    });
  }
  // Scheduled-job failures (pg_cron): a concrete automation outage, upgraded
  // from the generic pg_cron nudge when we can actually see the run log. The
  // nudge only fires as a fallback when there's no run-detail visibility.
  const failingJobs = a.sql.cronJobs.filter((r) => num(r.failed_runs) > 0);
  if (failingJobs.length > 0) {
    const names = failingJobs
      .slice(0, 3)
      .map((r) => String(r.jobname))
      .join(", ");
    out.push({
      severity: "med",
      category: "Performance",
      title: `${failingJobs.length} scheduled job${failingJobs.length === 1 ? "" : "s"} failed in the last 7 days`,
      anchor: "#cron",
      evidence: `Failing: ${names}${failingJobs.length > 3 ? ", ..." : ""}`,
      ...meta("cron_job_failing"),
    });
  } else if (
    a.sql.extensions.some((r) => String(r.name) === "pg_cron") &&
    a.sql.cronJobs.length === 0
  ) {
    out.push({
      severity: "low",
      category: "Performance",
      title: "pg_cron is installed - review scheduled-job run history for failures/overruns",
      anchor: "#extensions",
      ...meta("pg_cron_review"),
    });
  }

  // pg_hba weak-auth from a non-loopback source (pg_hba_file_rules, superuser).
  // NOT an SSL check: Supabase's standard pg_hba is all `host ... scram-sha-256`
  // and TLS terminates at the pooler/proxy, so host-vs-hostssl says nothing about
  // the public posture and firing on it is pure noise (it matches every project).
  // What IS actionable is a trust/password/ident rule for a non-loopback,
  // non-replication address - it admits connections with no or downgradeable
  // auth. hbaRules is only populated by a superuser --db-url (the read-only user
  // is denied the view), so this is inherently a no-PAT signal.
  if (a.sql.hbaRules.length > 0) {
    const loopback = (addr: string) =>
      addr === "" || addr === "localhost" || addr.startsWith("127.") || addr === "::1";
    const weak = a.sql.hbaRules.filter((r) => {
      const m = String(r.auth_method ?? "").toLowerCase();
      return (
        (m === "trust" || m === "password" || m === "ident") &&
        !loopback(String(r.address ?? "")) &&
        String(r.database ?? "") !== "replication"
      );
    });
    if (weak.length > 0) {
      out.push({
        severity: "med",
        category: "Security",
        title: `pg_hba allows weak/no authentication from a non-loopback address (${weak.length} rule${weak.length === 1 ? "" : "s"})`,
        anchor: "#hba",
        ...meta("hba_weak_auth"),
      });
    }
  }

  // No-PAT PITR negative: the authoritative backups plane is absent, and a
  // superuser sees WAL archiving is NOT running (archive_mode off, or on with
  // nothing archived). HEDGED: archive_mode semantics on Supabase aren't a
  // guaranteed 1:1 with the PITR add-on, so this is low severity and worded as
  // "no continuous WAL archiving detected", not "PITR is off". Gated to no-PAT
  // (backups absent) so it never contradicts the authoritative pitr_enabled.
  if (!a.backups && a.sql.walArchiving.length > 0) {
    const w = a.sql.walArchiving[0] as SqlRow;
    const mode = String(w.archive_mode ?? "").toLowerCase();
    const archivingLive = (mode === "on" || mode === "always") && num(w.archived_count) > 0;
    if (!archivingLive) {
      out.push({
        severity: "low",
        category: "Capacity",
        title: "No continuous WAL archiving detected (point-in-time recovery may be off)",
        anchor: "#walarchiving",
        ...meta("pitr_absent"),
      });
    }
  }

  // Data integrity: page-checksum failures (pg_stat_database, both modes). A
  // non-zero count is on-disk corruption caught by the checksum layer - the
  // strongest integrity signal Postgres emits, so it is high severity.
  const cksum = num(a.sql.checksumFailures[0]?.checksum_failures);
  if (cksum > 0) {
    const when = a.sql.checksumFailures[0]?.checksum_last_failure;
    out.push({
      severity: "high",
      category: "Capacity",
      title: `${cksum} page-checksum failure${cksum === 1 ? "" : "s"} detected (on-disk corruption)`,
      anchor: "#infra",
      evidence: when ? `Most recent: ${String(when)}.` : undefined,
      ...meta("checksum_failure"),
    });
  }

  // amcheck integrity findings (opt-in, superuser + extension gated in collect).
  // Each row from bt_index_check / verify_heapam is a corruption hit.
  for (const r of a.sql.amcheckIndex) {
    out.push({
      severity: "high",
      category: "Capacity",
      title: `Index corruption: ${String(r.index ?? r.name ?? "an index")} failed amcheck`,
      anchor: "#infra",
      evidence: r.message ? String(r.message) : undefined,
      ...meta("index_corruption"),
    });
  }
  for (const r of a.sql.amcheckHeap) {
    out.push({
      severity: "high",
      category: "Capacity",
      title: `Heap corruption: ${String(r.table ?? r.relation ?? "a table")} failed verify_heapam`,
      anchor: "#infra",
      evidence: r.message ? String(r.message) : undefined,
      ...meta("heap_corruption"),
    });
  }

  // Config tuning (static GUC sanity, from pgSettings - both modes).
  out.push(...configTuningFindings(a));

  // Security config (auth / network / SSL) - sbperf-original Security findings.
  out.push(...securityConfigFindings(a));

  out.sort(
    (x, y) =>
      SEV_RANK[x.severity] - SEV_RANK[y.severity] || CAT_RANK[x.category] - CAT_RANK[y.category],
  );
  return out;
}

/**
 * Confirmed-healthy observations - the counterweight to findings. Only emitted
 * when the underlying signal was actually COLLECTED and is genuinely good; on a
 * degraded/unreachable project we assert nothing (absence of data is not
 * health). Each positive mirrors a finding's threshold, so a positive and its
 * corresponding finding are mutually exclusive by construction.
 */
export function derivePositives(a: Analysis): Positive[] {
  const out: Positive[] = [];
  const errored = new Set(a.errors.map((e) => e.source));
  const set = settingsMap(a.sql.pgSettings);
  const advisorLints = new Set(a.advisors.performance.map((l) => String(l.name)));

  // Never claim health when diagnostics were incomplete. In no-PAT mode the
  // project status is simply unknown (no Management API) - that's NOT degraded,
  // full SQL + trends were still collected - so gate on status only when the
  // Management API was available (mirrors the report banner logic).
  const degraded = a.meta.managementApi !== false && a.meta.status !== "ACTIVE_HEALTHY";
  if (degraded || errored.has("sql:dbSize")) return out;

  // Trend-health counterweights to the capacity findings (data-aware: only when
  // there's a real window). A finding and its positive are mutually exclusive.
  const tpoints = (title: string) => a.trends.find((t) => t.title === title)?.points ?? [];
  const cpuPts = tpoints("CPU utilization (%)");
  if (sufficient(cpuPts)) {
    const s = trendStat(cpuPts)!;
    const hot =
      sustainedFrac(cpuPts, THRESHOLDS.cpuSustainedHighPct, ">=") >= THRESHOLDS.cpuSustainedFrac;
    const oversized =
      s.spanDays >= THRESHOLDS.cpuOversizeMinDays && s.p95 <= THRESHOLDS.cpuOversizePct;
    if (!hot && !oversized)
      out.push({
        category: "Capacity",
        title: `CPU well-provisioned: avg ${Math.round(s.mean)}%, peak ${Math.round(s.max)}% over ${Math.round(s.spanDays)}d`,
      });
  }
  const memPts = tpoints("Memory used (%)");
  if (sufficient(memPts)) {
    const s = trendStat(memPts)!;
    if (sustainedFrac(memPts, THRESHOLDS.memSustainedHighPct, ">=") < THRESHOLDS.memSustainedFrac)
      out.push({
        category: "Capacity",
        title: `Memory within healthy range: avg ${Math.round(s.mean)}%, peak ${Math.round(s.max)}% over ${Math.round(s.spanDays)}d`,
      });
  }
  const diskPts = tpoints("Disk used (%)");
  if (sufficient(diskPts)) {
    const s = trendStat(diskPts)!;
    const daysToFull = projectDaysTo(s, 100);
    const filling =
      s.direction === "rising" &&
      daysToFull != null &&
      daysToFull <= Math.min(THRESHOLDS.diskFillHorizonDays, 3 * s.spanDays);
    if (!filling)
      out.push({
        category: "Capacity",
        title: `Disk stable: ${Math.round(s.last)}% used, no fill risk over ${Math.round(s.spanDays)}d`,
      });
  }

  // Mirror the finding's volume gate: don't praise a tiny/idle DB's ratio. null
  // (pre-field analysis.json) falls back to ratio-only for back-compat.
  const cachePraiseOk =
    a.sql.cacheBlocksAccessed == null || a.sql.cacheBlocksAccessed >= THRESHOLDS.cacheHitMinBlocks;
  if (cachePraiseOk && a.sql.cacheHitPct != null && a.sql.cacheHitPct >= THRESHOLDS.cacheHitPct) {
    out.push({
      category: "Performance",
      title: `Cache hit ratio ${a.sql.cacheHitPct}% (>= ${THRESHOLDS.cacheHitPct}% target)`,
    });
  }
  const totalPolicies = a.sql.rlsPolicies.length;
  const unwrapped = a.sql.rlsPolicies.filter((r) => r.unwrapped_auth === true).length;
  // Don't claim "all wrapped" if the advisor's auth_rls_initplan lint says
  // otherwise (its detection can differ from ours - defer to the advisor).
  if (totalPolicies > 0 && unwrapped === 0 && !advisorLints.has("auth_rls_initplan")) {
    out.push({
      category: "Performance",
      title: `All ${totalPolicies} RLS ${totalPolicies === 1 ? "policy wraps" : "policies wrap"} auth in a subselect`,
    });
  }
  if (
    totalPolicies > 0 &&
    !errored.has("sql:rlsUnindexed") &&
    appRows(a.sql.rlsUnindexed).length === 0
  ) {
    out.push({ category: "Performance", title: "All RLS policy columns are indexed" });
  }
  // Mirror the finding's mutual exclusivity: don't claim "no unused indexes" when
  // the advisor reported some (its scope is authoritative), nor when our own
  // application-schema scan finds any.
  if (
    !errored.has("sql:indexStats") &&
    !advisorLints.has("unused_index") &&
    appRows(a.sql.indexStats).length > 0 &&
    appRows(a.sql.indexStats).filter((r) => r.unused === true).length === 0
  ) {
    out.push({ category: "Performance", title: "No unused indexes" });
  }
  if (
    a.upgrade?.current_app_version &&
    a.upgrade.latest_app_version &&
    a.upgrade.current_app_version === a.upgrade.latest_app_version
  ) {
    out.push({ category: "Performance", title: "Postgres is on the latest platform version" });
  }
  if (set.get("statement_timeout") !== "0" && set.get("statement_timeout") != null) {
    out.push({ category: "Performance", title: "statement_timeout is configured" });
  }
  // Meaningful negatives: an empty plane that was actually COLLECTED is a
  // healthy affirmative, not silence. Guard on the errored set so a
  // not-collected plane never renders as a false positive.
  if (!errored.has("sql:replicationSlots") && a.sql.replicationSlots.length === 0) {
    out.push({ category: "Capacity", title: "No replication slots retaining WAL" });
  }
  if (!errored.has("sql:topByWal") && a.sql.topByWal.length === 0) {
    out.push({ category: "Performance", title: "No WAL-heavy statements in the window" });
  }
  // Capacity
  if (a.disk?.usedBytes != null && a.disk.availBytes != null) {
    const total = a.disk.usedBytes + a.disk.availBytes;
    if (total > 0 && a.disk.usedBytes / total < THRESHOLDS.diskFullFrac) {
      out.push({
        category: "Capacity",
        title: `Disk ${Math.round((a.disk.usedBytes / total) * 100)}% full (headroom available)`,
      });
    }
  }
  const conns = a.sql.connections.reduce((s, r) => s + num(r.connections), 0);
  const maxConn = num(set.get("max_connections"));
  if (
    !errored.has("sql:connections") &&
    maxConn > 0 &&
    conns / maxConn < THRESHOLDS.directConnFrac
  ) {
    out.push({
      category: "Capacity",
      title: `Connections at ${Math.round((conns / maxConn) * 100)}% of max (${conns}/${maxConn})`,
    });
  }
  const maxXidPct = a.sql.txidWraparound.reduce((mx, r) => Math.max(mx, num(r.pct_wraparound)), 0);
  if (!errored.has("sql:txidWraparound") && maxXidPct < THRESHOLDS.txidWarnPct) {
    out.push({ category: "Capacity", title: "Transaction-ID wraparound headroom is healthy" });
  }
  if (a.backups?.pitr_enabled) {
    out.push({ category: "Capacity", title: "Point-in-time recovery (PITR) is enabled" });
  }
  // No-PAT proxy for PITR: the authoritative backups plane is absent, but a
  // superuser --db-url can see whether continuous WAL archiving is actually
  // running. archive_mode on/always + a non-zero archived_count = WAL is being
  // shipped, the mechanism PITR relies on. This is an INFERENCE about the DB,
  // not the platform add-on flag, so it is worded as "WAL archiving active" and
  // only emitted when the Management API's backups plane wasn't collected (so it
  // never contradicts the authoritative flag above).
  if (!a.backups && a.sql.walArchiving.length > 0) {
    const w = a.sql.walArchiving[0] as SqlRow;
    const mode = String(w.archive_mode ?? "").toLowerCase();
    if ((mode === "on" || mode === "always") && num(w.archived_count) > 0) {
      out.push({
        category: "Capacity",
        title: "Continuous WAL archiving is active (archive_mode=on) - PITR-style recoverability",
      });
    }
  }
  // Security config counterweights (only when the plane was collected - PAT).
  const scfg = a.security;
  if (scfg) {
    const nr = scfg.networkRestrictions;
    if (nr) {
      const cidrs = [...(nr.config?.dbAllowedCidrs ?? []), ...(nr.config?.dbAllowedCidrsV6 ?? [])];
      const openCidr = (c: string) => c === "0.0.0.0/0" || c === "::/0";
      if (cidrs.length > 0 && !cidrs.some(openCidr))
        out.push({ category: "Security", title: "Database network restrictions are configured" });
    }
    if (scfg.sslEnforcement?.currentConfig.database === true)
      out.push({ category: "Security", title: "SSL enforcement is on" });
    const auth = scfg.auth;
    if (auth) {
      if (auth.mailer_autoconfirm === false)
        out.push({ category: "Security", title: "Email confirmation is required for signups" });
      if (
        auth.mfa_totp_verify_enabled === true ||
        auth.mfa_phone_verify_enabled === true ||
        auth.mfa_web_authn_verify_enabled === true
      )
        out.push({ category: "Security", title: "At least one MFA factor is enabled" });
    }
  }
  // Edge functions all healthy (only when there are functions with real traffic).
  const fnsWithTraffic = a.functionStats.filter((f) => f.requests >= THRESHOLDS.fnMinRequests);
  if (
    fnsWithTraffic.length > 0 &&
    fnsWithTraffic.every((f) => f.serverErr / f.requests < THRESHOLDS.fnErrWarnFrac)
  ) {
    out.push({
      category: "Performance",
      title: `All ${fnsWithTraffic.length} active edge ${fnsWithTraffic.length === 1 ? "function is" : "functions are"} within the 5xx budget`,
    });
  }
  return out;
}
