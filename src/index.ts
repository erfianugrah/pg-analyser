#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import pkg from "../package.json" with { type: "json" };
import { type Brand, DEFAULT_BRAND, loadBrand } from "./brand.ts";
import { collect } from "./collect.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { type DbTarget, parseDbConfig, type RawEntry, resolveTargets } from "./dbtargets.ts";
import { deriveFindings } from "./findings.ts";
import { mergeTrends, parseTrendsFile } from "./importtrends.ts";
import { Management } from "./management.ts";
import { clientFromEnv, narrate } from "./narrate.ts";
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
import { makeTransport } from "./transport.ts";
import { computeTrends } from "./trends.ts";

const VERSION = pkg.version;

// Report branding, resolved once at startup (Supabase default; --brand /
// SBPERF_BRAND / ./sbperf.brand.json override). Read by the render call sites.
let activeBrand: Brand = DEFAULT_BRAND;

function usage(code = 1): never {
  console.log(`sbperf ${VERSION} - Supabase performance analysis

Usage:
  sbperf analyze  --ref <ref> [--out <dir>]   fetch all planes -> analysis.json
  sbperf report   <dir>                       analysis.json -> report.html
  sbperf summary  <dir>                        analysis.json -> summary.html (non-technical)
  sbperf pdf      <dir>                        analysis.json -> report.pdf + summary.pdf
  sbperf narrate  <dir>                        analysis.json -> narrative.md (LLM pass)
  sbperf import-trends <dir> <file...>         merge external CSV/JSON series into analysis.trends
  sbperf full     --ref <ref> [--out <dir>]    analyze + report + pdf
  sbperf full     --ref <r1> --ref <r2> ...    audit several projects + combined index
  sbperf full     --all [--org <slug>]         audit every project + index.html
  sbperf snapshot --ref <ref> [--store <db>]   collect + append to the history store
  sbperf export-prometheus <dir> [--ref <ref>] history store -> OpenMetrics for promtool backfill
  sbperf scrape-init --ref <ref> [--dir <d>]   write the Prometheus+Grafana stack

Flags:
  --store <db>         history SQLite file (default ~/.sbperf/history.db)
  --retention-days <n> snapshot: prune snapshots older than n days (default 90, 0=keep)
  --interval <window>  analytics timeframe: 15min|30min|1hr|3hr|1day|3day|7day (default 1day)
  --db-url <connstr>   run SQL as superuser via a Postgres connstring (or SBPERF_DB_URL);
                       full-access tier for your own projects - PAT still used for
                       API planes + metrics. Default is the PAT read-only runner.
                       REPEATABLE: pass multiple --db-url to sweep several DBs
                       ('full' -> per-DB reports + index; 'snapshot' -> each to store).
  --db-config <file>   JSON list of {name?,ref?,dbUrl} targets (gitignored); an
                       alternative to repeated --db-url. ref auto-derived if omitted.
  --prometheus <url>   trends from a scraper's Prometheus instead of the history store
  --no-sync-check      skip the on-by-default upstream sync check (offline runs)
  --narrative          report/pdf: embed the LLM narrative (run 'narrate' first)
  --brand <file>       white-label branding JSON (default: Supabase; or SBPERF_BRAND
                       / ./sbperf.brand.json)
  -h, --help           show this help
  -v, --version        print version

narrate: LLM synthesis over the corpus + enriched findings (analysis.json ->
narrative.md). Set SBPERF_LLM_BASE_URL + SBPERF_LLM_MODEL (SBPERF_LLM_API_KEY if
the endpoint needs one). Works with OpenAI, a local llama-server, OpenRouter, etc.

30-day trends: run 'sbperf snapshot' on a schedule (e.g. hourly cron) to
accumulate history, then 'sbperf report <dir>' draws trends from the store.
No Prometheus/Grafana needed - sbperf is the collector, SQLite is the store.

<ref> is your project ref (dashboard URL, or 'supabase projects list').
Auth: set SUPABASE_ACCESS_TOKEN (see .env.example).`);
  process.exit(code);
}

type Flags = {
  _: string[];
  ref?: string;
  refs: string[];
  out?: string;
  dir?: string;
  org?: string;
  all?: boolean;
  prometheus?: string;
  store?: string;
  retentionDays?: number;
  interval?: string;
  dbUrls: string[];
  dbConfig?: string;
  noSyncCheck?: boolean;
  narrative?: boolean;
  brand?: string;
};

/** Analytics-endpoint timeframe enum (verified live 2026-07; iso ranges are clamped). */
const INTERVALS = ["15min", "30min", "1hr", "3hr", "1day", "3day", "7day"] as const;
function parseFlags(argv: string[]): Flags {
  const out: Flags = { _: [], dbUrls: [], refs: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") usage(0);
    // --ref is repeatable: each occurrence accumulates into refs[]; the last
    // also sets `ref` so single-ref call sites keep working unchanged.
    else if (a === "--ref") {
      const v = argv[++i]!;
      out.refs.push(v);
      out.ref = v;
    } else if (a === "--out") out.out = argv[++i];
    else if (a === "--dir") out.dir = argv[++i];
    else if (a === "--org") out.org = argv[++i];
    else if (a === "--prometheus") out.prometheus = argv[++i];
    else if (a === "--store") out.store = argv[++i];
    else if (a === "--retention-days") out.retentionDays = Number(argv[++i]);
    else if (a === "--interval") out.interval = argv[++i];
    else if (a === "--db-url") out.dbUrls.push(argv[++i]!);
    else if (a === "--db-config") out.dbConfig = argv[++i];
    else if (a === "--brand") out.brand = argv[++i];
    else if (a === "--all") out.all = true;
    else if (a === "--no-sync-check") out.noSyncCheck = true;
    else if (a === "--narrative") out.narrative = true;
    else if (a?.startsWith("--")) usage();
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
  const html = render(analysis, { brand: activeBrand });
  const summaryHtml = renderSummary(analysis, activeBrand);
  await Bun.write(join(dir, "report.html"), html);
  await Bun.write(join(dir, "summary.html"), summaryHtml);
  await htmlToPdf(html, join(dir, "report.pdf"));
  await htmlToPdf(summaryHtml, join(dir, "summary.pdf"));
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
  const transport = makeTransport(loadCfg());
  console.error(
    `> auditing ${targets.length} databases (superuser --db-url; PAT for API + metrics)`,
  );
  const rows: IndexRow[] = [];
  for (const t of targets) {
    const label = t.name ?? t.ref;
    process.stderr.write(`  - ${label} (${t.ref}) `);
    const runner = new DirectSqlRunner(t.dbUrl);
    try {
      const analysis = await collect(t.ref, transport, VERSION, {
        prometheusUrl,
        interval,
        sqlRunner: runner,
        syncCheck,
      }).finally(() => runner.close());
      const counts = await emitReport(analysis, join(outBase, t.ref));
      rows.push({
        name: t.name ?? analysis.meta.name,
        ref: t.ref,
        status: analysis.meta.status,
        ...counts,
        dir: t.ref,
      });
      console.error(`ok (${counts.high + counts.med + counts.low} findings)`);
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
      console.error(`FAILED: ${msg}`);
    }
  }
  await mkdir(outBase, { recursive: true });
  await Bun.write(
    join(outBase, "index.html"),
    renderIndex(rows, new Date().toISOString(), activeBrand),
  );
  console.error(`> index: ${join(outBase, "index.html")}`);
}

async function doAll(
  orgFilter: string | undefined,
  outBase: string,
  prometheusUrl?: string,
  interval?: string,
  syncCheck?: boolean,
  refFilter?: Set<string>,
): Promise<void> {
  const transport = makeTransport(loadCfg());
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
      process.stderr.write(`  - [${orgName}] ${p.name} (${p.id}) `);
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
        console.error(`ok (${counts.high + counts.med + counts.low} findings)`);
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
        console.error(`FAILED: ${msg}`);
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

function defaultOut(ref: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return join("reports", `${ref}-${ts}`);
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
    const m = new Management(makeTransport(loadConfig()));
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
  const transport = makeTransport(loadCfg());
  const runner = dbUrl ? new DirectSqlRunner(dbUrl) : undefined;
  if (runner) console.error("> SQL tier: superuser (--db-url); PAT used for API + metrics");
  console.error(`> analyzing ${ref} via the Management API`);
  const analysis = await collect(ref, transport, VERSION, {
    prometheusUrl,
    interval,
    sqlRunner: runner,
    syncCheck,
  }).finally(() => runner?.close());
  await mkdir(outDir, { recursive: true });
  const jsonPath = join(outDir, "analysis.json");
  await Bun.write(jsonPath, JSON.stringify(analysis, null, 2));
  console.error(
    `> ${jsonPath} (${analysis.advisors.performance.length} perf / ${analysis.advisors.security.length} sec advisors, ${analysis.errors.length} collection notes)`,
  );
  return jsonPath;
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
  const transport = makeTransport(loadCfg());
  const runner = dbUrl ? new DirectSqlRunner(dbUrl) : undefined;
  if (runner) console.error("> SQL tier: superuser (--db-url); PAT used for API + metrics");
  console.error(`> snapshot ${ref} via the Management API`);
  const analysis = await collect(ref, transport, VERSION, {
    interval,
    sqlRunner: runner,
    syncCheck,
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

async function doReport(dir: string, storePath?: string, narrative?: boolean): Promise<string> {
  const analysis = await loadAnalysis(dir);
  const path = storePath ?? DEFAULT_STORE;
  if (await Bun.file(path).exists()) fillTrendsFromStore(analysis, path);
  if (narrative && !analysis.narrative)
    console.error("> --narrative given but analysis.json has none; run 'sbperf narrate' first");
  const htmlPath = join(dir, "report.html");
  await Bun.write(htmlPath, render(analysis, { narrative, brand: activeBrand }));
  const summaryPath = join(dir, "summary.html");
  await Bun.write(summaryPath, renderSummary(analysis, activeBrand));
  console.error(`> ${htmlPath}`);
  console.error(`> ${summaryPath}`);
  return htmlPath;
}

async function doSummary(dir: string): Promise<string> {
  const analysis = await loadAnalysis(dir);
  const path = join(dir, "summary.html");
  await Bun.write(path, renderSummary(analysis, activeBrand));
  console.error(`> ${path}`);
  return path;
}

async function doPdf(dir: string, narrative?: boolean): Promise<string> {
  const analysis = await loadAnalysis(dir);
  const pdfPath = join(dir, "report.pdf");
  await htmlToPdf(render(analysis, { narrative, brand: activeBrand }), pdfPath);
  console.error(`> ${pdfPath}`);
  const summaryPdf = join(dir, "summary.pdf");
  await htmlToPdf(renderSummary(analysis, activeBrand), summaryPdf);
  console.error(`> ${summaryPdf}`);
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

async function doNarrate(dir: string): Promise<string> {
  const analysis = await loadAnalysis(dir);
  const built = clientFromEnv();
  if ("error" in built) throw new Error(built.error);
  console.error(`> narrating ${dir} via ${built.client.model}`);
  const md = await narrate(analysis, built.client);
  analysis.narrative = md;
  // Persist onto analysis.json so `report --narrative` can embed it without
  // re-running the LLM, and emit the markdown + a standalone HTML page.
  await Bun.write(join(dir, "analysis.json"), JSON.stringify(analysis, null, 2));
  const path = join(dir, "narrative.md");
  await Bun.write(path, md);
  await Bun.write(join(dir, "narrative.html"), renderNarrativePage(analysis, activeBrand));
  console.error(`> ${path}`);
  console.error(`> ${join(dir, "narrative.html")}`);
  console.error("> embed in the report with: sbperf report " + dir + " --narrative");
  return path;
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

  try {
    // Resolve superuser DB targets: repeatable --db-url / --db-config / SBPERF_DB_URL.
    // Env fallback applies only when no explicit --db-url / --db-config is given
    // (otherwise the config/flags are authoritative and env would double-count).
    const flagUrls = flags.dbUrls.length
      ? flags.dbUrls
      : !flags.dbConfig && process.env.SBPERF_DB_URL
        ? [process.env.SBPERF_DB_URL]
        : [];
    let targets: DbTarget[] = [];
    if (flags.dbConfig || flagUrls.length) {
      const raw: RawEntry[] = [];
      if (flags.dbConfig) raw.push(...parseDbConfig(await Bun.file(flags.dbConfig).text()));
      for (const u of flagUrls) raw.push({ dbUrl: u });
      targets = resolveTargets(raw, raw.length === 1 ? flags.ref : undefined);
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
        await doReport(dir, flags.store, flags.narrative);
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
      case "pdf": {
        const dir = flags._[0];
        if (!dir) usage();
        await doPdf(dir, flags.narrative);
        break;
      }
      case "narrate": {
        const dir = flags._[0];
        if (!dir) usage();
        await doNarrate(dir);
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
        if (targets.length > 1) {
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
        await doReport(dir);
        await doPdf(dir);
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
