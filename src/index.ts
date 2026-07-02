#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import pkg from "../package.json" with { type: "json" };
import { collect } from "./collect.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { deriveFindings } from "./findings.ts";
import { Management } from "./management.ts";
import { htmlToPdf } from "./report/pdf.ts";
import { type IndexRow, render, renderIndex, renderSummary } from "./report/render.ts";
import { writeScraper } from "./scraper.ts";
import { DirectSqlRunner } from "./sqlrunner.ts";
import { DEFAULT_STORE, HistoryStore } from "./store.ts";
import { makeTransport } from "./transport.ts";
import { computeTrends } from "./trends.ts";

const VERSION = pkg.version;

function usage(code = 1): never {
  console.log(`sbperf ${VERSION} - Supabase performance analysis

Usage:
  sbperf analyze  --ref <ref> [--out <dir>]   fetch all planes -> analysis.json
  sbperf report   <dir>                       analysis.json -> report.html
  sbperf summary  <dir>                        analysis.json -> summary.html (non-technical)
  sbperf pdf      <dir>                        analysis.json -> report.pdf + summary.pdf
  sbperf full     --ref <ref> [--out <dir>]    analyze + report + pdf
  sbperf full     --all [--org <slug>]         audit every project + index.html
  sbperf snapshot --ref <ref> [--store <db>]   collect + append to the history store
  sbperf scrape-init --ref <ref> [--dir <d>]   write the Prometheus+Grafana stack

Flags:
  --store <db>         history SQLite file (default ~/.sbperf/history.db)
  --retention-days <n> snapshot: prune snapshots older than n days (default 90, 0=keep)
  --interval <window>  analytics timeframe: 15min|30min|1hr|3hr|1day|3day|7day (default 1day)
  --db-url <connstr>   run SQL as superuser via a Postgres connstring (or SBPERF_DB_URL);
                       full-access tier for your own projects - PAT still used for
                       API planes + metrics. Default is the PAT read-only runner.
  --prometheus <url>   trends from a scraper's Prometheus instead of the history store
  -h, --help           show this help
  -v, --version        print version

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
  out?: string;
  dir?: string;
  org?: string;
  all?: boolean;
  prometheus?: string;
  store?: string;
  retentionDays?: number;
  interval?: string;
  dbUrl?: string;
};

/** Analytics-endpoint timeframe enum (verified live 2026-07; iso ranges are clamped). */
const INTERVALS = ["15min", "30min", "1hr", "3hr", "1day", "3day", "7day"] as const;
function parseFlags(argv: string[]): Flags {
  const out: Flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") usage(0);
    else if (a === "--ref") out.ref = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--dir") out.dir = argv[++i];
    else if (a === "--org") out.org = argv[++i];
    else if (a === "--prometheus") out.prometheus = argv[++i];
    else if (a === "--store") out.store = argv[++i];
    else if (a === "--retention-days") out.retentionDays = Number(argv[++i]);
    else if (a === "--interval") out.interval = argv[++i];
    else if (a === "--db-url") out.dbUrl = argv[++i];
    else if (a === "--all") out.all = true;
    else if (a?.startsWith("--")) usage();
    else if (a) out._.push(a);
  }
  return out;
}

async function doAll(
  orgFilter: string | undefined,
  outBase: string,
  prometheusUrl?: string,
  interval?: string,
): Promise<void> {
  const transport = makeTransport(loadCfg());
  const m = new Management(transport);
  let projects = await m.projects();
  if (orgFilter) projects = projects.filter((p) => p.organization_id === orgFilter);
  if (!projects.length) throw new Error("no projects found");
  console.error(`> auditing ${projects.length} projects via the Management API`);

  const rows: IndexRow[] = [];
  for (const p of projects) {
    const dir = join(outBase, p.id);
    process.stderr.write(`  - ${p.name} (${p.id}) `);
    try {
      const analysis = await collect(p.id, transport, VERSION, { prometheusUrl, interval });
      await mkdir(dir, { recursive: true });
      await Bun.write(join(dir, "analysis.json"), JSON.stringify(analysis, null, 2));
      const html = render(analysis);
      const summaryHtml = renderSummary(analysis);
      await Bun.write(join(dir, "report.html"), html);
      await Bun.write(join(dir, "summary.html"), summaryHtml);
      await htmlToPdf(html, join(dir, "report.pdf"));
      await htmlToPdf(summaryHtml, join(dir, "summary.pdf"));
      const f = deriveFindings(analysis);
      rows.push({
        name: p.name,
        ref: p.id,
        status: p.status,
        high: f.filter((x) => x.severity === "high").length,
        med: f.filter((x) => x.severity === "med").length,
        low: f.filter((x) => x.severity === "low").length,
        dir: p.id,
      });
      console.error(`ok (${f.length} findings)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      rows.push({
        name: p.name,
        ref: p.id,
        status: p.status,
        high: 0,
        med: 0,
        low: 0,
        dir: p.id,
        error: msg,
      });
      console.error(`FAILED: ${msg}`);
    }
  }
  await mkdir(outBase, { recursive: true });
  await Bun.write(join(outBase, "index.html"), renderIndex(rows, new Date().toISOString()));
  console.error(`> index: ${join(outBase, "index.html")}`);
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

async function doAnalyze(
  ref: string,
  outDir: string,
  prometheusUrl?: string,
  interval?: string,
  dbUrl?: string,
): Promise<string> {
  const transport = makeTransport(loadCfg());
  const runner = dbUrl ? new DirectSqlRunner(dbUrl) : undefined;
  if (runner) console.error("> SQL tier: superuser (--db-url); PAT used for API + metrics");
  console.error(`> analyzing ${ref} via the Management API`);
  const analysis = await collect(ref, transport, VERSION, {
    prometheusUrl,
    interval,
    sqlRunner: runner,
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
): Promise<void> {
  const transport = makeTransport(loadCfg());
  const runner = dbUrl ? new DirectSqlRunner(dbUrl) : undefined;
  if (runner) console.error("> SQL tier: superuser (--db-url); PAT used for API + metrics");
  console.error(`> snapshot ${ref} via the Management API`);
  const analysis = await collect(ref, transport, VERSION, {
    interval,
    sqlRunner: runner,
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

async function doReport(dir: string, storePath?: string): Promise<string> {
  const analysis = await loadAnalysis(dir);
  const path = storePath ?? DEFAULT_STORE;
  if (await Bun.file(path).exists()) fillTrendsFromStore(analysis, path);
  const htmlPath = join(dir, "report.html");
  await Bun.write(htmlPath, render(analysis));
  const summaryPath = join(dir, "summary.html");
  await Bun.write(summaryPath, renderSummary(analysis));
  console.error(`> ${htmlPath}`);
  console.error(`> ${summaryPath}`);
  return htmlPath;
}

async function doSummary(dir: string): Promise<string> {
  const analysis = await loadAnalysis(dir);
  const path = join(dir, "summary.html");
  await Bun.write(path, renderSummary(analysis));
  console.error(`> ${path}`);
  return path;
}

async function doPdf(dir: string): Promise<string> {
  const analysis = await loadAnalysis(dir);
  const pdfPath = join(dir, "report.pdf");
  await htmlToPdf(render(analysis), pdfPath);
  console.error(`> ${pdfPath}`);
  const summaryPdf = join(dir, "summary.pdf");
  await htmlToPdf(renderSummary(analysis), summaryPdf);
  console.error(`> ${summaryPdf}`);
  return pdfPath;
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

  try {
    switch (cmd) {
      case "analyze": {
        if (!flags.ref) usage();
        await doAnalyze(
          flags.ref,
          flags.out ?? defaultOut(flags.ref),
          flags.prometheus,
          flags.interval,
          flags.dbUrl ?? process.env.SBPERF_DB_URL,
        );
        break;
      }
      case "report": {
        const dir = flags._[0];
        if (!dir) usage();
        await doReport(dir, flags.store);
        break;
      }
      case "snapshot": {
        if (!flags.ref) usage();
        await doSnapshot(
          flags.ref,
          flags.out ?? defaultOut(flags.ref),
          flags.store ?? DEFAULT_STORE,
          flags.retentionDays ?? 90,
          flags.interval,
          flags.dbUrl ?? process.env.SBPERF_DB_URL,
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
        await doPdf(dir);
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
          );
          break;
        }
        if (!flags.ref) usage();
        const dir = flags.out ?? defaultOut(flags.ref);
        await doAnalyze(
          flags.ref,
          dir,
          flags.prometheus,
          flags.interval,
          flags.dbUrl ?? process.env.SBPERF_DB_URL,
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
