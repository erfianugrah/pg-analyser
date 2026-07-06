#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import pkg from "../package.json" with { type: "json" };
import { type Brand, DEFAULT_BRAND, loadBrand } from "./brand.ts";
import { evaluateGate, type GateOptions, renderGateText } from "./check.ts";
import { collect } from "./collect.ts";
import { ConfigError, loadConfig, loadConfigOptional } from "./config.ts";
import {
  type DbTarget,
  parseDbConfig,
  type RawEntry,
  REF,
  regionFromConnstring,
  resolveTargets,
} from "./dbtargets.ts";
import { computeDiff, renderDiffText } from "./diff.ts";
import { deriveFindings } from "./findings.ts";
import { mergeTrends, parseTrendsFile } from "./importtrends.ts";
import { Management } from "./management.ts";
import { buildMessages, clientFromEnv, narrate } from "./narrate.ts";
import { loadOverlay } from "./overlay.ts";
import { type Profile, parseProfile, profileEntries, resolveGrafana } from "./profile.ts";
import { backfillInstructions, toOpenMetrics } from "./promexport.ts";
import { htmlToPdf } from "./report/pdf.ts";
import {
  type IndexRow,
  type OrgRow,
  render,
  renderIndex,
  renderNarrativePage,
  renderOrgIndex,
  renderSummary,
} from "./report/render.ts";
import type { Analysis } from "./schemas.ts";
import { writeScraper } from "./scraper.ts";
import { DirectSqlRunner } from "./sqlrunner.ts";
import { DEFAULT_STORE, HistoryStore } from "./store.ts";
import { makeTransport, type Transport } from "./transport.ts";
import { computeTrends } from "./trends.ts";

const VERSION = pkg.version;

// Report branding, resolved once at startup (Supabase default; --brand /
// SBPERF_BRAND / ./sbperf.brand.json override). Read by the render call sites.
let activeBrand: Brand = DEFAULT_BRAND;
// The active work profile (--profile <file.json>): force-no-PAT + region-mapped
// Grafana creds + customer databases, all in one gitignored JSON. Consulted by
// doAllDbs to resolve each project's regional Grafana. Null unless --profile.
let activeProfile: Profile | null = null;

function usage(code = 1): never {
  console.log(`sbperf ${VERSION} - Supabase performance analysis

Usage:
  sbperf analyze  --ref <ref> [--out <dir>]   fetch all planes -> analysis.json
  sbperf report   <dir>                       analysis.json -> report.html (technical + business)
  sbperf summary  <dir>                        analysis.json -> summary.html (optional plain-language one-pager)
  sbperf pdf      <dir>                        analysis.json -> report.pdf
  sbperf narrate  <dir>                        analysis.json -> narrative.md (LLM pass, needs SBPERF_LLM_*)
  sbperf narrate  <dir> --print-prompt         write prompt.md (grounded prompt) to paste into any chat LLM
  sbperf narrate  <dir> --import <file>|-      embed a pasted LLM reply back (file or stdin); no endpoint needed
  sbperf import-trends <dir> <file...>         merge external CSV/JSON series into analysis.trends
  sbperf full     --ref <ref> [--out <dir>]    analyze + report + pdf
  sbperf full     --ref <r1>,<r2> ...          audit several projects + combined index
  sbperf full     --ref-file <refs.txt|.csv>   ...refs from a file (one per line / CSV)
  sbperf full     --all [--org <slug>]         audit every project + index.html
  sbperf snapshot --ref <ref> [--store <db>]   collect + append to the history store
  sbperf diff     <oldDir> <newDir>            compare two analysis.json runs (findings delta + query regressions)
  sbperf diff     --ref <ref> [--store <db>]   compare the two most recent store snapshots
  sbperf check    <dir> [--fail-on <sev>]      CI gate: exit nonzero if findings breach the threshold
  sbperf export-prometheus <dir> [--ref <ref>] history store -> OpenMetrics for promtool backfill
  sbperf scrape-init --ref <ref> [--dir <d>]   write the Prometheus+Grafana stack

Flags:
  --store <db>         history SQLite file (default ~/.sbperf/history.db)
  --retention-days <n> snapshot: prune snapshots older than n days (default 90, 0=keep)
  --interval <window>  analytics timeframe: 15min|30min|1hr|3hr|1day|3day|7day (default 1day)
  --db-url <connstr>   run SQL as superuser via a Postgres connstring; full-access
                       tier for your own projects - PAT still used for API planes +
                       metrics. Default is the PAT read-only runner. REPEATABLE:
                       sweep several DBs ('full' -> per-DB reports + index;
                       'snapshot' -> each to store). Env fallback (no flag given):
                       SBPERF_DB_URL plus numbered SBPERF_DB_URL_2, _3, ...
  --db-config <file>   JSON list of {name?,ref?,dbUrl} targets (gitignored); an
                       alternative to repeated --db-url. ref auto-derived if omitted.
                       ./sbperf.databases.json is auto-loaded when no db flag/env set.
  --prometheus <url>   trends from a scraper's Prometheus instead of the history store
  --prometheus-token <t>  bearer token for an auth'd datasource - e.g. a Grafana
                       datasource proxy (/api/datasources/proxy/uid/<uid>) or an
                       auth'd Prometheus (env: SBPERF_PROMETHEUS_TOKEN)
  --prometheus-cookie <c> session Cookie header for a datasource behind an SSO
                       proxy that a bearer token can't traverse (the same auth
                       the Grafana UI uses). Token wins if both are set.
                       (env: SBPERF_PROMETHEUS_COOKIE)
  --prometheus-matcher <m> project-label selector template for a scraper whose
                       schema isn't the default supabase_project_ref="{ref}";
                       "{ref}" -> the project ref (env: SBPERF_PROMETHEUS_MATCHER)
  --no-pat             force no-PAT mode: ignore any token (incl. the CLI
                       ~/.supabase/access-token fallback) and run on --db-url +
                       Grafana alone. For a work profile auditing customer
                       projects you have a connstring for but no PAT.
                       (env: SBPERF_NO_PAT=1)
  --profile <file>     one gitignored JSON = the whole work config: forced
                       no-PAT + region-mapped Grafana creds (per-region cookie)
                       + customer databases. full --profile <file> sweeps them,
                       resolving each project's regional Grafana by the region
                       derived from its connstring. See sbperf.profile.example.json.
  --trend-days <n>     trend query window in days (default 30; the store/Grafana
                       is a TSDB so 90 is fine). profile.trendDays wins for a
                       profile run. (env: SBPERF_TREND_DAYS)
  --fail-on <sev>      check: gate severity - high|med|low (default high); exit 1 if breached
  --category <cat>     check/diff: restrict the gate to Performance|Security|Capacity
  --new-since <dir>    check: gate only on findings NEW vs the baseline dir's analysis.json
  --no-sync-check      skip the on-by-default upstream sync check (offline runs)
  --narrative          report/pdf: embed the narrative summary (run 'narrate' first)
  --print-prompt       narrate: write the grounded prompt to prompt.md for copy-paste
  --import <file>|-    narrate: embed a pasted LLM reply (file, or - for stdin)
  --brand <file>       white-label branding JSON (default: Supabase; or SBPERF_BRAND
                       / ./sbperf.brand.json)
  --overlay <file>     per-project review overlay JSON (hide sections + notes;
                       default: ./sbperf.overlays/<ref>.json or ~/.sbperf/overlays/<ref>.json)
  -h, --help           show this help
  -v, --version        print version

narrate: writes the executive summary (analysis.json -> narrative.md), embedded
at the top of the report with --narrative. Three ways to run it:
  1. auto: set SBPERF_LLM_BASE_URL + SBPERF_LLM_MODEL (+ _API_KEY if needed);
     works with OpenAI, a local llama-server, OpenRouter, etc.
  2. copy-paste: 'narrate <dir> --print-prompt' writes prompt.md - paste it into
     any chat LLM (pi.dev / ChatGPT / Claude), then bring the reply back with
     'narrate <dir> --import <reply.md>' (or 'pbpaste | narrate <dir> --import -').
  3. skip it: the report has a deterministic executive summary without any LLM.

30-day trends: run 'sbperf snapshot' on a schedule (e.g. hourly cron) to
accumulate history, then 'sbperf report <dir>' draws trends from the store.
No Prometheus/Grafana needed - sbperf is the collector, SQLite is the store.

<ref> is your project ref (dashboard URL, or 'supabase projects list').
Auth: set SUPABASE_ACCESS_TOKEN (see .env.example).

No-PAT mode: with NO SUPABASE_ACCESS_TOKEN but a --db-url (or SBPERF_DB_URL /
sbperf.databases.json), sbperf runs on the superuser connstring alone - SQL
diagnostics + advisors from the self-hosted splinter lints (+ Grafana trends if
SBPERF_PROMETHEUS_* is set). Management-API planes (provisioning, backups,
pooler, metrics, analytics) are skipped. This is the customer-audit path where
you have a DB connstring but no PAT. '--all' still needs a PAT.`);
  process.exit(code);
}

type Flags = {
  _: string[];
  ref?: string;
  refs: string[];
  refFiles: string[];
  out?: string;
  dir?: string;
  org?: string;
  all?: boolean;
  prometheus?: string;
  prometheusToken?: string;
  prometheusCookie?: string;
  prometheusMatcher?: string;
  noPat?: boolean;
  profile?: string;
  trendDays?: string;
  store?: string;
  retentionDays?: number;
  interval?: string;
  dbUrls: string[];
  dbConfig?: string;
  noSyncCheck?: boolean;
  failOn?: string;
  category?: string;
  newSince?: string;
  narrative?: boolean;
  printPrompt?: boolean;
  import?: string;
  brand?: string;
  overlay?: string;
};

/** Analytics-endpoint timeframe enum (verified live 2026-07; iso ranges are clamped). */
const INTERVALS = ["15min", "30min", "1hr", "3hr", "1day", "3day", "7day"] as const;
function parseFlags(argv: string[]): Flags {
  const out: Flags = { _: [], dbUrls: [], refs: [], refFiles: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") usage(0);
    // --ref is repeatable AND accepts comma/space-delimited lists in a single
    // value (--ref a,b or --ref "a b"). Each token accumulates into refs[]; the
    // last also sets `ref` so single-ref call sites keep working unchanged.
    else if (a === "--ref") {
      for (const r of splitRefs(argv[++i]!)) {
        out.refs.push(r);
        out.ref = r;
      }
    }
    // --ref-file <path>: read refs from a .txt (one per line) or .csv. Any
    // ref-shaped token (20 lowercase letters) is picked up; headers, names,
    // blank lines and #-comments are ignored. Repeatable.
    else if (a === "--ref-file") out.refFiles.push(argv[++i]!);
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--dir") out.dir = argv[++i];
    else if (a === "--org") out.org = argv[++i];
    else if (a === "--prometheus") out.prometheus = argv[++i];
    else if (a === "--prometheus-token") out.prometheusToken = argv[++i];
    else if (a === "--prometheus-cookie") out.prometheusCookie = argv[++i];
    else if (a === "--prometheus-matcher") out.prometheusMatcher = argv[++i];
    else if (a === "--no-pat") out.noPat = true;
    else if (a === "--profile") out.profile = argv[++i];
    else if (a === "--trend-days") out.trendDays = argv[++i];
    else if (a === "--store") out.store = argv[++i];
    else if (a === "--retention-days") out.retentionDays = Number(argv[++i]);
    else if (a === "--interval") out.interval = argv[++i];
    else if (a === "--db-url") out.dbUrls.push(argv[++i]!);
    else if (a === "--db-config") out.dbConfig = argv[++i];
    else if (a === "--brand") out.brand = argv[++i];
    else if (a === "--overlay") out.overlay = argv[++i];
    else if (a === "--all") out.all = true;
    else if (a === "--fail-on") out.failOn = argv[++i];
    else if (a === "--category") out.category = argv[++i];
    else if (a === "--new-since") out.newSince = argv[++i];
    else if (a === "--no-sync-check") out.noSyncCheck = true;
    else if (a === "--narrative") out.narrative = true;
    else if (a === "--print-prompt") out.printPrompt = true;
    else if (a === "--import") {
      const v = argv[++i];
      if (v === undefined || (v.startsWith("--") && v !== "-")) {
        console.error("error: --import needs a file path (or - for stdin)");
        process.exit(1);
      }
      out.import = v;
    } else if (a?.startsWith("--")) usage();
    else if (a) out._.push(a);
  }
  return out;
}

/** Write a project's full report set to `dir` and return its finding counts. */
async function emitReport(
  analysis: Analysis,
  dir: string,
): Promise<{ high: number; med: number; low: number }> {
  await mkdir(dir, { recursive: true });
  await Bun.write(join(dir, "analysis.json"), JSON.stringify(analysis, null, 2));
  // Join with the history store so combined reports get the Resource snapshot
  // sparklines too (analysis.json is point-in-time; trends live in the store).
  if (await Bun.file(DEFAULT_STORE).exists()) fillTrendsFromStore(analysis, DEFAULT_STORE);
  const overlay = await loadOverlay({ ref: analysis.meta.ref });
  const html = render(analysis, { brand: activeBrand, overlay });
  await Bun.write(join(dir, "report.html"), html);
  await htmlToPdf(html, join(dir, "report.pdf"));
  const f = deriveFindings(analysis);
  return {
    high: f.filter((x) => x.severity === "high").length,
    med: f.filter((x) => x.severity === "med").length,
    low: f.filter((x) => x.severity === "low").length,
  };
}

/**
 * Sweep multiple superuser databases (--db-url x N / --db-config) into per-DB
 * report dirs + an index. SQL runs as superuser per target; the PAT transport
 * still serves each target's API planes + metrics (keyed by its ref).
 */
async function doAllDbs(
  targets: DbTarget[],
  outBase: string,
  prometheusUrl?: string,
  interval?: string,
  syncCheck?: boolean,
): Promise<void> {
  const transport = resolveTransport();
  console.error(
    `> auditing ${targets.length} database${targets.length === 1 ? "" : "s"} (superuser --db-url; ${transport ? "PAT for API + metrics" : "no PAT - db-url + Grafana only"})`,
  );
  const progress = makeProgress(targets.length);
  const rows: IndexRow[] = [];
  for (const t of targets) {
    const label = t.name ?? t.ref;
    const runner = new DirectSqlRunner(t.dbUrl);
    // Per-project regional Grafana: a profile maps the project's region (derived
    // from its connstring) to that region's host/uid/cookie. Falls back to the
    // global --prometheus / SBPERF_PROMETHEUS_* when there's no profile match.
    const graf = activeProfile ? resolveGrafana(activeProfile, t.region) : null;
    // A profile WITH a grafana block but no entry for this project's region =
    // trends can't be fetched; surface it in the report note + the done line
    // rather than a silently trend-less report.
    const grafanaGap =
      activeProfile?.grafana && !graf
        ? `no Grafana config for region "${t.region ?? "(underivable from connstring)"}" - trends skipped`
        : null;
    progress.step(`${label} (${t.ref})`);
    try {
      const analysis = await collect(t.ref, transport, VERSION, {
        prometheusUrl: graf?.url ?? prometheusUrl,
        prometheusCookie: graf?.cookie,
        prometheusMatcher: graf?.matcher,
        trendDays: activeProfile?.trendDays,
        interval,
        sqlRunner: runner,
        syncCheck,
        name: t.name,
        region: t.region ?? regionFromConnstring(t.dbUrl) ?? undefined,
      }).finally(() => runner.close());
      if (grafanaGap) analysis.errors.push({ source: "trends", message: grafanaGap });
      const counts = await emitReport(analysis, join(outBase, t.ref));
      rows.push({
        name: t.name ?? analysis.meta.name,
        ref: t.ref,
        status: analysis.meta.status,
        ...counts,
        dir: t.ref,
      });
      const n = counts.high + counts.med + counts.low;
      progress.done(
        `ok - ${n} finding${n === 1 ? "" : "s"}${grafanaGap ? " (trends skipped)" : ""}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      rows.push({
        name: label,
        ref: t.ref,
        status: "?",
        high: 0,
        med: 0,
        low: 0,
        dir: t.ref,
        error: msg,
      });
      progress.done(`FAILED: ${msg}`);
    }
  }
  progress.stop();
  await mkdir(outBase, { recursive: true });
  await Bun.write(
    join(outBase, "index.html"),
    renderIndex(rows, new Date().toISOString(), activeBrand),
  );
  console.error(`> index: ${join(outBase, "index.html")}`);
}

/**
 * Live progress for multi-project sweeps. On a TTY it animates a spinner + bar
 * in place so the run never looks hung; when piped (CI/logs) it prints one plain
 * line per completed step. Each finished step also leaves a permanent line.
 */
function makeProgress(total: number): {
  step: (label: string) => void;
  done: (result: string) => void;
  stop: () => void;
} {
  const tty = process.stderr.isTTY === true;
  const frames = ["|", "/", "-", "\\"];
  let completed = 0;
  let label = "";
  let frame = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const bar = () => {
    const w = 14;
    const f = total ? Math.round((w * completed) / total) : 0;
    return `[${"#".repeat(f)}${"-".repeat(w - f)}]`;
  };
  const paint = () => {
    process.stderr.write(
      `\r\x1b[2K${bar()} ${completed}/${total} ${frames[frame++ % frames.length]} ${label}`,
    );
  };
  return {
    step(l) {
      label = l;
      if (tty) {
        if (timer) clearInterval(timer);
        paint();
        timer = setInterval(paint, 90);
      }
    },
    done(result) {
      completed++;
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      if (tty) process.stderr.write("\r\x1b[2K");
      console.error(`  ${bar()} ${completed}/${total}  ${label}  ${result}`);
    },
    stop() {
      if (timer) clearInterval(timer);
      if (tty) process.stderr.write("\r\x1b[2K");
    },
  };
}

async function doAll(
  orgFilter: string | undefined,
  outBase: string,
  prometheusUrl?: string,
  interval?: string,
  syncCheck?: boolean,
  refFilter?: Set<string>,
): Promise<void> {
  const cfg = noPatForced() ? null : loadConfigOptional();
  if (!cfg)
    throw new Error(
      "--all needs a PAT: it enumerates projects via the Management API (and cannot run in forced no-PAT mode). For no-PAT, pass explicit --db-url connstrings (or sbperf.databases.json) to 'full'.",
    );
  const transport = makeTransport(cfg);
  const m = new Management(transport);
  let projects = await m.projects();
  if (orgFilter) projects = projects.filter((p) => p.organization_id === orgFilter);
  if (refFilter) {
    projects = projects.filter((p) => refFilter.has(p.id));
    const missing = [...refFilter].filter((r) => !projects.some((p) => p.id === r));
    if (missing.length) throw new Error(`ref(s) not visible to this PAT: ${missing.join(", ")}`);
  }
  if (!projects.length) throw new Error("no projects found");

  // Org metadata for grouping (best-effort: the PAT may lack org scope, in which
  // case we group by organization_id and name the dir by that id).
  const orgMeta = new Map<string, { name: string; slug: string }>();
  try {
    for (const o of await m.organizations())
      orgMeta.set(o.id, { name: o.name, slug: o.slug ?? o.id });
  } catch (err) {
    console.error(
      `> could not list organizations (${err instanceof Error ? err.message : err}); grouping by org id`,
    );
  }

  // Group projects by org.
  const groups = new Map<string, typeof projects>();
  for (const p of projects) {
    const key = p.organization_id ?? "ungrouped";
    const g = groups.get(key);
    if (g) g.push(p);
    else groups.set(key, [p]);
  }
  const date = new Date().toISOString().slice(0, 10);
  console.error(
    `> auditing ${projects.length} project${projects.length === 1 ? "" : "s"} across ${groups.size} org${groups.size === 1 ? "" : "s"}`,
  );
  const progress = makeProgress(projects.length);

  const usedOrgDirs = new Set<string>();
  const orgRows: OrgRow[] = [];
  for (const [orgId, orgProjects] of groups) {
    const meta = orgMeta.get(orgId);
    const orgName = meta?.name ?? (orgId === "ungrouped" ? "Ungrouped" : orgId);
    // Prefer the readable org NAME for the dir (the API slug is often the id).
    let orgDir = slugify(orgName) || slugify(meta?.slug ?? "") || orgId;
    while (usedOrgDirs.has(orgDir)) orgDir = `${orgDir}-${orgId.slice(0, 6)}`;
    usedOrgDirs.add(orgDir);

    const rows: IndexRow[] = [];
    let high = 0;
    let med = 0;
    let low = 0;
    let errors = 0;
    const usedProjDirs = new Set<string>();
    for (const p of orgProjects) {
      // project dir: <name>-<date>, deduped with the ref if names collide.
      let projDir = `${slugify(p.name) || p.id}-${date}`;
      while (usedProjDirs.has(projDir))
        projDir = `${slugify(p.name) || p.id}-${p.id.slice(0, 6)}-${date}`;
      usedProjDirs.add(projDir);
      progress.step(`[${orgName}] ${p.name}`);
      try {
        const analysis = await collect(p.id, transport, VERSION, {
          prometheusUrl,
          interval,
          syncCheck,
        });
        const counts = await emitReport(analysis, join(outBase, orgDir, projDir));
        rows.push({ name: p.name, ref: p.id, status: p.status, ...counts, dir: projDir });
        high += counts.high;
        med += counts.med;
        low += counts.low;
        const n = counts.high + counts.med + counts.low;
        progress.done(`ok - ${n} finding${n === 1 ? "" : "s"}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors++;
        rows.push({
          name: p.name,
          ref: p.id,
          status: p.status,
          high: 0,
          med: 0,
          low: 0,
          dir: projDir,
          error: msg,
        });
        progress.done(`FAILED: ${msg}`);
      }
    }
    await mkdir(join(outBase, orgDir), { recursive: true });
    await Bun.write(
      join(outBase, orgDir, "index.html"),
      renderIndex(rows, new Date().toISOString(), activeBrand),
    );
    orgRows.push({
      name: orgName,
      dir: orgDir,
      projects: orgProjects.length,
      high,
      med,
      low,
      errors,
    });
  }
  progress.stop();
  await mkdir(outBase, { recursive: true });
  await Bun.write(
    join(outBase, "index.html"),
    renderOrgIndex(orgRows, new Date().toISOString(), activeBrand),
  );
  console.error(`> index: ${join(outBase, "index.html")}`);
}

/** Slug for a filesystem dir: lowercase, alnum + dashes, collapsed. */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/** Load config and print a one-line notice when the CLI token is the source. */
function loadCfg() {
  const cfg = loadConfig();
  if (cfg.tokenSource === "cli")
    console.error("> auth: using Supabase CLI token (~/.supabase/access-token)");
  return cfg;
}

/**
 * Resolve a Management-API transport, or null for no-PAT mode. Returns null
 * (with a one-line notice) when no PAT is resolvable - collect then runs on the
 * superuser --db-url + Grafana trends alone, skipping all Management planes.
 */
/** Forced no-PAT mode (--no-pat / SBPERF_NO_PAT). Ignores any resolvable token
 * - including the personal ~/.supabase/access-token CLI fallback - so a work
 * profile auditing customer projects never accidentally runs PAT mode. */
function noPatForced(): boolean {
  return ["1", "true", "yes"].includes((process.env.SBPERF_NO_PAT ?? "").trim().toLowerCase());
}

function resolveTransport(): Transport | null {
  if (noPatForced()) {
    console.error(
      "> no-PAT mode forced (--no-pat / SBPERF_NO_PAT); ignoring any token - Management API planes skipped",
    );
    return null;
  }
  const cfg = loadConfigOptional();
  if (!cfg) {
    console.error(
      "> no PAT found - running no-PAT mode (superuser SQL + Grafana trends; Management API planes skipped)",
    );
    return null;
  }
  if (cfg.tokenSource === "cli")
    console.error("> auth: using Supabase CLI token (~/.supabase/access-token)");
  return makeTransport(cfg);
}

function defaultOut(ref: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return join("reports", `${ref}-${ts}`);
}

/** Split a --ref value on commas/whitespace into individual tokens. */
function splitRefs(v: string): string[] {
  return v.split(/[\s,]+/).filter(Boolean);
}

/** Default multi-DB config file auto-loaded from cwd when no db flag/env given. */
const DEFAULT_DB_CONFIG = "sbperf.databases.json";

/**
 * Collect superuser connstrings from the environment: SBPERF_DB_URL plus the
 * numbered SBPERF_DB_URL_2, SBPERF_DB_URL_3, ... (gaps tolerated). Each var
 * holds ONE full connstring - we never split a single var, since a password can
 * contain any delimiter. Order: base var first, then ascending index.
 */
function collectEnvDbUrls(): string[] {
  const urls: string[] = [];
  if (process.env.SBPERF_DB_URL) urls.push(process.env.SBPERF_DB_URL);
  for (let i = 2; i <= 99; i++) {
    const v = process.env[`SBPERF_DB_URL_${i}`];
    if (v) urls.push(v);
  }
  return urls;
}

/**
 * Extract project refs from a --ref-file (.txt one-per-line, or .csv). Any
 * ref-shaped token (20 lowercase letters) is kept; headers, project names,
 * regions, blank lines and #-comments fall away because they don't match the
 * shape. Throws if the file has content but yields no ref so a wrong column /
 * format fails loud instead of silently auditing nothing.
 */
function parseRefsFile(text: string, path: string): string[] {
  const tokens = text.split(/[\s,]+/).filter(Boolean);
  const refs = tokens.filter((t) => REF.test(t));
  if (tokens.length && !refs.length)
    throw new Error(
      `${path}: no project refs found (expected 20-lowercase-letter refs, one per line or CSV)`,
    );
  return refs;
}

/**
 * Nested default output dir for a single-project run: reports/<org>/<project>-<ts>/
 * to match the `--all` layout (org -> project -> dated run). Resolves the org
 * name + project name via the Management API; falls back to the flat
 * `reports/<ref>-<ts>` on any lookup failure (e.g. a PAT without org scope, or
 * a bare superuser --db-url whose ref isn't a real Supabase project).
 */
async function nestedOut(ref: string): Promise<string> {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  try {
    // No PAT (or forced no-PAT) -> no Management API to resolve names -> flat.
    const cfg = noPatForced() ? null : loadConfigOptional();
    if (!cfg) return defaultOut(ref);
    const m = new Management(makeTransport(cfg));
    const projects = await m.projects();
    const proj = projects.find((p) => p.id === ref);
    if (!proj) return defaultOut(ref);
    const projSlug = slugify(proj.name) || ref;
    let orgSlug = "ungrouped";
    if (proj.organization_id) {
      orgSlug = proj.organization_id;
      try {
        const org = (await m.organizations()).find((o) => o.id === proj.organization_id);
        if (org) orgSlug = slugify(org.name) || slugify(org.slug ?? "") || proj.organization_id;
      } catch {
        // PAT may lack org scope; group by organization_id.
      }
    }
    return join("reports", orgSlug, `${projSlug}-${ts}`);
  } catch {
    return defaultOut(ref);
  }
}

async function doAnalyze(
  ref: string,
  outDir: string,
  prometheusUrl?: string,
  interval?: string,
  dbUrl?: string,
  syncCheck?: boolean,
): Promise<string> {
  const transport = resolveTransport();
  if (!transport && !dbUrl)
    throw new Error(
      "no PAT and no --db-url: nothing to analyze. Set SUPABASE_ACCESS_TOKEN, or pass a --db-url connstring for no-PAT db-url mode.",
    );
  const runner = dbUrl ? new DirectSqlRunner(dbUrl) : undefined;
  if (runner)
    console.error(
      `> SQL tier: superuser (--db-url)${transport ? "; PAT used for API + metrics" : " (no PAT - advisors via splinter, no Management planes)"}`,
    );
  console.error(
    `> analyzing ${ref} via ${transport ? "the Management API" : "no-PAT db-url mode"}`,
  );
  const analysis = await collect(ref, transport, VERSION, {
    prometheusUrl,
    interval,
    sqlRunner: runner,
    syncCheck,
    region: dbUrl ? (regionFromConnstring(dbUrl) ?? undefined) : undefined,
  }).finally(() => runner?.close());
  await mkdir(outDir, { recursive: true });
  const jsonPath = join(outDir, "analysis.json");
  await Bun.write(jsonPath, JSON.stringify(analysis, null, 2));
  console.error(
    `> ${jsonPath} (${analysis.advisors.performance.length} perf / ${analysis.advisors.security.length} sec advisors, ${analysis.errors.length} collection notes)`,
  );
  return jsonPath;
}

/**
 * Compare two runs into a findings-delta + query-regression report. Either two
 * report dirs ('diff <old> <new>') or the two most recent store snapshots for a
 * ref ('diff --ref <ref>'). Purely informational - always exits 0; use 'check'
 * to gate CI on severity.
 */
async function doDiff(
  argA: string | undefined,
  argB: string | undefined,
  ref: string | undefined,
  storePath: string,
): Promise<void> {
  let a: Analysis;
  let b: Analysis;
  if (argA && argB) {
    a = await loadAnalysis(argA);
    b = await loadAnalysis(argB);
  } else if (ref) {
    const store = HistoryStore.open(storePath);
    try {
      const recent = store.recentAnalyses(ref, 2);
      if (recent.length < 2)
        throw new Error(
          `need >= 2 snapshots for ${ref} in ${storePath} (have ${recent.length}) - run 'sbperf snapshot --ref ${ref}' on a schedule first`,
        );
      b = recent[0]!; // newest = current
      a = recent[1]!; // older = baseline
    } finally {
      store.close();
    }
  } else {
    throw new Error(
      "diff needs two report dirs ('sbperf diff <old> <new>') or --ref <ref> to compare the two latest store snapshots",
    );
  }
  console.log(renderDiffText(computeDiff(a, b)));
}

const CATEGORIES = ["Performance", "Security", "Capacity"] as const;

/**
 * CI gate over a run's findings. Exits nonzero (via process.exit(1)) when a
 * finding breaches --fail-on (default high), optionally scoped to a --category
 * or to only findings NEW since a --new-since baseline dir.
 */
async function doCheck(dir: string, flags: Flags): Promise<void> {
  const failOn = (flags.failOn ?? "high").toLowerCase();
  if (failOn !== "high" && failOn !== "med" && failOn !== "low")
    throw new Error("--fail-on must be one of: high | med | low");
  if (flags.category && !CATEGORIES.includes(flags.category as (typeof CATEGORIES)[number]))
    throw new Error(`--category must be one of: ${CATEGORIES.join(" | ")}`);
  const a = await loadAnalysis(dir);
  const baseline = flags.newSince ? await loadAnalysis(flags.newSince) : null;
  const opts: GateOptions = {
    failOn,
    category: flags.category as GateOptions["category"],
    newOnly: !!flags.newSince,
  };
  const result = evaluateGate(a, baseline, opts);
  console.log(renderGateText(result));
  if (!result.pass) process.exit(1);
}

async function loadAnalysis(dir: string) {
  const { Analysis } = await import("./schemas.ts");
  const path = join(dir, "analysis.json");
  if (!(await Bun.file(path).exists())) {
    throw new Error(
      `no analysis.json in ${dir} - run 'sbperf analyze --ref <ref> --out ${dir}' first`,
    );
  }
  return Analysis.parse(await Bun.file(path).json());
}

/**
 * Collect a fresh snapshot and append it to the history store. Meant for a
 * schedule (hourly cron); trends accrue as snapshots accumulate. Also writes
 * analysis.json so the run doubles as a one-shot analyze.
 */
async function doSnapshot(
  ref: string,
  outDir: string,
  storePath: string,
  retentionDays: number,
  interval?: string,
  dbUrl?: string,
  syncCheck?: boolean,
): Promise<void> {
  const transport = resolveTransport();
  if (!transport && !dbUrl)
    throw new Error(
      "no PAT and no --db-url: nothing to snapshot. Set SUPABASE_ACCESS_TOKEN, or pass a --db-url connstring.",
    );
  const runner = dbUrl ? new DirectSqlRunner(dbUrl) : undefined;
  if (runner) console.error("> SQL tier: superuser (--db-url); PAT used for API + metrics");
  console.error(`> snapshot ${ref} via ${transport ? "the Management API" : "no-PAT db-url mode"}`);
  const analysis = await collect(ref, transport, VERSION, {
    interval,
    sqlRunner: runner,
    syncCheck,
    region: dbUrl ? (regionFromConnstring(dbUrl) ?? undefined) : undefined,
  }).finally(() => runner?.close());
  await mkdir(outDir, { recursive: true });
  await Bun.write(join(outDir, "analysis.json"), JSON.stringify(analysis, null, 2));

  const store = HistoryStore.open(storePath);
  try {
    store.record(analysis);
    const pruned = retentionDays > 0 ? store.prune(ref, retentionDays) : 0;
    const n = store.snapshotCount(ref);
    console.error(
      `> stored -> ${storePath} (${n} snapshot${n === 1 ? "" : "s"} for ${ref}${pruned ? `, pruned ${pruned}` : ""})`,
    );
    console.error(
      n >= 2
        ? "> run 'sbperf report' to render trends from accumulated history"
        : "> trends need >=2 snapshots; schedule this command to accumulate history",
    );
  } finally {
    store.close();
  }
}

/**
 * Fill analysis.trends from the history store when no scraper-sourced trends
 * are already baked in (i.e. analyze wasn't run with --prometheus). Reads the
 * store read-only; needs >=2 snapshots for the ref to compute any rate series.
 */
function fillTrendsFromStore(
  analysis: Awaited<ReturnType<typeof loadAnalysis>>,
  storePath: string,
) {
  if (analysis.trends.length) return; // scraper trends win if present
  const store = HistoryStore.open(storePath);
  try {
    const snaps = store.loadForTrends(analysis.meta.ref);
    if (snaps.length >= 2) analysis.trends = computeTrends(snaps);
  } finally {
    store.close();
  }
}

/**
 * Export the accumulated history store as OpenMetrics for promtool backfill,
 * so Grafana can query sbperf's corpus retroactively. One ref (--ref) or all
 * refs in the store (labels carry supabase_project_ref to disambiguate).
 */
async function doExportPrometheus(
  outDir: string,
  ref: string | undefined,
  storePath: string,
): Promise<void> {
  if (!(await Bun.file(storePath).exists())) {
    throw new Error(`no history store at ${storePath} - run 'sbperf snapshot' first`);
  }
  const store = HistoryStore.open(storePath);
  try {
    const refs = ref ? [ref] : store.refs();
    if (!refs.length) throw new Error(`history store ${storePath} is empty`);
    const snaps = refs.flatMap((r) => store.loadForTrends(r));
    if (!snaps.length) throw new Error(`no snapshots for ${ref ?? "any ref"} in ${storePath}`);

    const om = toOpenMetrics(snaps);
    const seriesCount = (om.match(/^# TYPE /gm) ?? []).length;
    const sampleCount = snaps.reduce((n, s) => n + s.samples.length, 0);
    const tsList = snaps.map((s) => s.ts).sort((a, b) => a - b);
    const span = tsList.length
      ? `${new Date(tsList[0]! * 1000).toISOString()} .. ${new Date(tsList.at(-1)! * 1000).toISOString()}`
      : "(none)";

    await mkdir(outDir, { recursive: true });
    const omPath = join(outDir, `sbperf-${ref ?? "all"}.om`);
    await Bun.write(omPath, om);
    console.error(
      `> ${omPath} (${refs.length} ref(s), ${snaps.length} snapshots, ${seriesCount} families, ${sampleCount} samples)`,
    );
    console.error(`> time range: ${span}`);
    console.error("");
    console.error(backfillInstructions(omPath));
  } finally {
    store.close();
  }
}

async function doReport(
  dir: string,
  storePath?: string,
  narrative?: boolean,
  overlayFile?: string,
): Promise<string> {
  const analysis = await loadAnalysis(dir);
  const path = storePath ?? DEFAULT_STORE;
  if (await Bun.file(path).exists()) fillTrendsFromStore(analysis, path);
  if (narrative && !analysis.narrative)
    console.error("> --narrative given but analysis.json has none; run 'sbperf narrate' first");
  const overlay = await loadOverlay({ ref: analysis.meta.ref, file: overlayFile });
  const htmlPath = join(dir, "report.html");
  await Bun.write(htmlPath, render(analysis, { narrative, brand: activeBrand, overlay }));
  console.error(`> ${htmlPath}`);
  return htmlPath;
}

async function doSummary(dir: string): Promise<string> {
  const analysis = await loadAnalysis(dir);
  const path = join(dir, "summary.html");
  await Bun.write(path, renderSummary(analysis, activeBrand));
  console.error(`> ${path}`);
  return path;
}

async function doPdf(
  dir: string,
  narrative?: boolean,
  storePath?: string,
  overlayFile?: string,
): Promise<string> {
  const analysis = await loadAnalysis(dir);
  const store = storePath ?? DEFAULT_STORE;
  if (await Bun.file(store).exists()) fillTrendsFromStore(analysis, store);
  const overlay = await loadOverlay({ ref: analysis.meta.ref, file: overlayFile });
  const pdfPath = join(dir, "report.pdf");
  await htmlToPdf(render(analysis, { narrative, brand: activeBrand, overlay }), pdfPath);
  console.error(`> ${pdfPath}`);
  return pdfPath;
}

/**
 * Merge externally-exported time series (Grafana CSV export, Prometheus dump,
 * spreadsheet, ...) into analysis.trends so `report` renders them as native
 * trend panels. Vendor-neutral: sbperf ingests a file you produced, it never
 * talks to your dashboard.
 */
async function doImportTrends(dir: string, files: string[]): Promise<void> {
  if (!files.length) throw new Error("import-trends needs at least one CSV/JSON file");
  const analysis = await loadAnalysis(dir);
  let added = 0;
  for (const f of files) {
    const text = await Bun.file(f).text();
    const series = parseTrendsFile(f, text);
    if (!series.length) {
      console.error(`> ${f}: no usable series (need a time column + >=1 numeric column)`);
      continue;
    }
    analysis.trends = mergeTrends(analysis.trends, series);
    added += series.length;
    console.error(`> ${f}: ${series.length} series (${series.map((s) => s.title).join(", ")})`);
  }
  const path = join(dir, "analysis.json");
  await Bun.write(path, JSON.stringify(analysis, null, 2));
  console.error(`> merged ${added} series into ${path} (${analysis.trends.length} total)`);
  console.error("> run 'sbperf report' / 'pdf' to render them");
}

/** Persist a narrative markdown onto analysis.json + emit narrative.md/html. */
async function embedNarrative(dir: string, analysis: Analysis, md: string): Promise<string> {
  analysis.narrative = md;
  await Bun.write(join(dir, "analysis.json"), JSON.stringify(analysis, null, 2));
  const path = join(dir, "narrative.md");
  await Bun.write(path, md);
  await Bun.write(join(dir, "narrative.html"), renderNarrativePage(analysis, activeBrand));
  console.error(`> ${path}`);
  console.error(`> ${join(dir, "narrative.html")}`);
  console.error(`> embed in the report with: sbperf report ${dir} --narrative`);
  return path;
}

async function doNarrate(
  dir: string,
  opts: { printPrompt?: boolean; importPath?: string; storePath?: string } = {},
): Promise<string> {
  const analysis = await loadAnalysis(dir);

  // --import: read the reply from a chat LLM (file or '-' for stdin) and embed
  // it. No API/endpoint needed - this is the pi.dev / copy-paste round-trip.
  if (opts.importPath) {
    const src = opts.importPath;
    const raw = src === "-" ? await Bun.stdin.text() : await Bun.file(src).text();
    const md = raw.trim();
    const where = src === "-" ? "stdin" : src;
    if (!md) throw new Error(`imported narrative is empty (${where})`);
    // Guard the #1 footgun: importing prompt.md (the thing you paste INTO the
    // LLM) instead of the LLM's reply. The prompt has ## SYSTEM + ## USER;
    // a real analysis starts with ## Executive summary.
    if (/^##\s+SYSTEM\b/m.test(md) && /^##\s+USER\b/m.test(md))
      throw new Error(
        `${where} looks like the PROMPT (the sbperf --print-prompt output), not the model's reply. ` +
          `Paste the chat LLM's ANSWER (the analysis, starting with "## Executive summary") - not prompt.md.`,
      );
    const header = `<!-- imported into sbperf from ${where}; the deterministic report.html is ground truth -->\n\n`;
    return embedNarrative(dir, analysis, `${header}${md}\n`);
  }

  // Give the LLM (or the pasted prompt) the trend context too, without baking
  // trends into the persisted analysis.json (fill a throwaway copy).
  const forLlm = structuredClone(analysis);
  const store = opts.storePath ?? DEFAULT_STORE;
  if (await Bun.file(store).exists()) fillTrendsFromStore(forLlm, store);

  // --print-prompt: emit the exact grounded prompt (system rules + JSON digest)
  // so it can be pasted into any chat LLM (pi.dev, ChatGPT, Claude) by hand.
  if (opts.printPrompt) {
    const msgs = buildMessages(forLlm);
    const text = `${msgs
      .map((m) => `## ${m.role.toUpperCase()}\n\n${m.content}`)
      .join("\n\n---\n\n")}\n`;
    const p = join(dir, "prompt.md");
    await Bun.write(p, text);
    console.error(`> ${p}`);
    console.error("> 1. paste prompt.md into a chat LLM (pi.dev / ChatGPT / Claude)");
    console.error("> 2. save the LLM's ANSWER (not the prompt) to a file, e.g. reply.md");
    console.error(
      `> 3. sbperf narrate ${dir} --import reply.md   (or: pbpaste | sbperf narrate ${dir} --import -)`,
    );
    return p;
  }

  // Default: call the configured OpenAI-compatible endpoint.
  const built = clientFromEnv();
  if ("error" in built) throw new Error(built.error);
  console.error(`> narrating ${dir} via ${built.client.model}`);
  const md = await narrate(forLlm, built.client);
  return embedNarrative(dir, analysis, md);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (cmd === "--version" || cmd === "-v") {
    console.log(VERSION);
    process.exit(0);
  }
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") usage(0);
  const flags = parseFlags(argv.slice(1));
  if (flags.interval && !INTERVALS.includes(flags.interval as (typeof INTERVALS)[number])) {
    console.error(`error: --interval must be one of ${INTERVALS.join(" | ")}`);
    process.exit(1);
  }
  activeBrand = await loadBrand({ file: flags.brand });
  // Bridge the flag to the env that collect reads, so the token reaches
  // fetchTrends without threading a secret through every collect call site.
  if (flags.prometheusToken) process.env.SBPERF_PROMETHEUS_TOKEN = flags.prometheusToken;
  if (flags.prometheusCookie) process.env.SBPERF_PROMETHEUS_COOKIE = flags.prometheusCookie;
  if (flags.prometheusMatcher) process.env.SBPERF_PROMETHEUS_MATCHER = flags.prometheusMatcher;
  if (flags.noPat) process.env.SBPERF_NO_PAT = "1";
  if (flags.trendDays) process.env.SBPERF_TREND_DAYS = flags.trendDays;

  // A --profile <file.json> is the whole work config in one gitignored JSON:
  // force-no-PAT + region-mapped Grafana creds + customer databases. Loaded
  // before target resolution so its databases become the targets and noPat
  // forces the mode.
  if (flags.profile) {
    activeProfile = parseProfile(await Bun.file(flags.profile).text());
    if (activeProfile.noPat) process.env.SBPERF_NO_PAT = "1";
    console.error(
      `> profile: ${flags.profile} (${activeProfile.databases.length} db${activeProfile.databases.length === 1 ? "" : "s"}${activeProfile.noPat ? ", forced no-PAT" : ""})`,
    );
  }

  try {
    // Resolve superuser DB targets. Precedence: a --profile's databases win;
    // then explicit flags (--db-url repeatable + --db-config, merged). With NO
    // explicit db flag, fall back to env, then to an auto-discovered config file:
    //   1. --profile <file.json>       (its databases[])
    //   2. --db-url / --db-config      (explicit; merged)
    //   3. SBPERF_DB_URL[_N] env vars  (numbered; each a full connstring)
    //   4. ./sbperf.databases.json     (auto-loaded if it exists)
    let targets: DbTarget[] = [];
    const raw: RawEntry[] = [];
    if (activeProfile) {
      raw.push(...profileEntries(activeProfile));
    } else if (flags.dbUrls.length || flags.dbConfig) {
      if (flags.dbConfig) raw.push(...parseDbConfig(await Bun.file(flags.dbConfig).text()));
      for (const u of flags.dbUrls) raw.push({ dbUrl: u });
    } else {
      const envUrls = collectEnvDbUrls();
      if (envUrls.length) {
        for (const u of envUrls) raw.push({ dbUrl: u });
      } else if (await Bun.file(DEFAULT_DB_CONFIG).exists()) {
        raw.push(...parseDbConfig(await Bun.file(DEFAULT_DB_CONFIG).text()));
        console.error(`> db targets: auto-loaded ${DEFAULT_DB_CONFIG} (${raw.length})`);
      }
    }
    if (raw.length) targets = resolveTargets(raw, raw.length === 1 ? flags.ref : undefined);

    // Expand --ref-file(s) into refs[], then dedupe (a ref may repeat across
    // flags + files). The last file token also sets the single `ref`.
    for (const f of flags.refFiles) {
      const fromFile = parseRefsFile(await Bun.file(f).text(), f);
      flags.refs.push(...fromFile);
      if (fromFile.length) flags.ref = fromFile.at(-1);
    }
    if (flags.refs.length) {
      flags.refs = [...new Set(flags.refs)];
      flags.ref ??= flags.refs.at(-1);
    }
    const singleDbUrl = targets.length === 1 ? targets[0]!.dbUrl : undefined;

    switch (cmd) {
      case "analyze": {
        if (targets.length > 1)
          throw new Error("multiple --db-url given; use 'full' to sweep them into per-DB reports");
        if (flags.refs.length > 1)
          throw new Error(
            "multiple --ref given; 'analyze' writes one analysis.json - use 'full' for a combined multi-project index",
          );
        const ref = flags.ref ?? targets[0]?.ref;
        if (!ref) usage();
        await doAnalyze(
          ref,
          flags.out ?? (await nestedOut(ref)),
          flags.prometheus,
          flags.interval,
          singleDbUrl,
          !flags.noSyncCheck,
        );
        break;
      }
      case "report": {
        const dir = flags._[0];
        if (!dir) usage();
        await doReport(dir, flags.store, flags.narrative, flags.overlay);
        break;
      }
      case "export-prometheus": {
        const dir = flags._[0];
        if (!dir) usage();
        await doExportPrometheus(dir, flags.ref, flags.store ?? DEFAULT_STORE);
        break;
      }
      case "snapshot": {
        const store = flags.store ?? DEFAULT_STORE;
        const ret = flags.retentionDays ?? 90;
        if (targets.length > 1) {
          for (const t of targets)
            await doSnapshot(
              t.ref,
              flags.out ?? defaultOut(t.ref),
              store,
              ret,
              flags.interval,
              t.dbUrl,
              !flags.noSyncCheck,
            );
          break;
        }
        if (flags.refs.length > 1) {
          for (const r of flags.refs)
            await doSnapshot(
              r,
              flags.out ?? (await nestedOut(r)),
              store,
              ret,
              flags.interval,
              undefined,
              !flags.noSyncCheck,
            );
          break;
        }
        const ref = flags.ref ?? targets[0]?.ref;
        if (!ref) usage();
        await doSnapshot(
          ref,
          flags.out ?? (await nestedOut(ref)),
          store,
          ret,
          flags.interval,
          singleDbUrl,
          !flags.noSyncCheck,
        );
        break;
      }
      case "summary": {
        const dir = flags._[0];
        if (!dir) usage();
        await doSummary(dir);
        break;
      }
      case "diff": {
        await doDiff(flags._[0], flags._[1], flags.ref, flags.store ?? DEFAULT_STORE);
        break;
      }
      case "check": {
        const dir = flags._[0];
        if (!dir) usage();
        await doCheck(dir, flags);
        break;
      }
      case "pdf": {
        const dir = flags._[0];
        if (!dir) usage();
        await doPdf(dir, flags.narrative, flags.store, flags.overlay);
        break;
      }
      case "narrate": {
        const dir = flags._[0];
        if (!dir) usage();
        await doNarrate(dir, {
          printPrompt: flags.printPrompt,
          importPath: flags.import,
          storePath: flags.store,
        });
        break;
      }
      case "import-trends": {
        const [dir, ...files] = flags._;
        if (!dir) usage();
        await doImportTrends(dir, files);
        break;
      }
      case "full": {
        if (flags.all) {
          const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
          await doAll(
            flags.org,
            flags.out ?? join("reports", `all-${ts}`),
            flags.prometheus,
            flags.interval,
            !flags.noSyncCheck,
          );
          break;
        }
        // A profile (>=1 db) always sweeps via doAllDbs, so per-project regional
        // Grafana resolution lives in one place. Bare --db-url with >1 target
        // does the same; a single bare --db-url falls through to doAnalyze.
        if (activeProfile || targets.length > 1) {
          const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
          await doAllDbs(
            targets,
            flags.out ?? join("reports", `all-dbs-${ts}`),
            flags.prometheus,
            flags.interval,
            !flags.noSyncCheck,
          );
          break;
        }
        // Multiple --ref (PAT-only): audit just those projects, grouped org ->
        // project with a combined index, reusing the --all path via refFilter.
        if (flags.refs.length > 1) {
          const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
          await doAll(
            flags.org,
            flags.out ?? join("reports", `refs-${ts}`),
            flags.prometheus,
            flags.interval,
            !flags.noSyncCheck,
            new Set(flags.refs),
          );
          break;
        }
        const ref = flags.ref ?? targets[0]?.ref;
        if (!ref) usage();
        const dir = flags.out ?? (await nestedOut(ref));
        await doAnalyze(
          ref,
          dir,
          flags.prometheus,
          flags.interval,
          singleDbUrl,
          !flags.noSyncCheck,
        );
        await doReport(dir, undefined, undefined, flags.overlay);
        await doPdf(dir, undefined, undefined, flags.overlay);
        console.error(`> done: ${dir}`);
        break;
      }
      case "scrape-init": {
        if (!flags.ref) usage();
        const dir = await writeScraper(flags.ref, loadCfg(), flags.dir ?? "scraper-live");
        console.error(`> wrote scraper stack to ${dir} - cd there and 'docker compose up -d'`);
        break;
      }
      default:
        usage();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(err instanceof ConfigError ? `config error: ${msg}` : `error: ${msg}`);
    if (process.env.SBPERF_DEBUG && err instanceof Error) console.error(err.stack);
    process.exit(1);
  }
}

await main();
