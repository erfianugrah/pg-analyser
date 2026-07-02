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
import { makeTransport } from "./transport.ts";

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
  sbperf scrape-init --ref <ref> [--dir <d>]   write the Prometheus+Grafana stack

Flags:
  --prometheus <url>   embed 30-day trend charts from a scraper's Prometheus
  -h, --help           show this help
  -v, --version        print version

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
};
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
      const analysis = await collect(p.id, transport, VERSION, { prometheusUrl });
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

async function doAnalyze(ref: string, outDir: string, prometheusUrl?: string): Promise<string> {
  const transport = makeTransport(loadCfg());
  console.error(`> analyzing ${ref} via the Management API`);
  const analysis = await collect(ref, transport, VERSION, { prometheusUrl });
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

async function doReport(dir: string): Promise<string> {
  const analysis = await loadAnalysis(dir);
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

  try {
    switch (cmd) {
      case "analyze": {
        if (!flags.ref) usage();
        await doAnalyze(flags.ref, flags.out ?? defaultOut(flags.ref), flags.prometheus);
        break;
      }
      case "report": {
        const dir = flags._[0];
        if (!dir) usage();
        await doReport(dir);
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
          await doAll(flags.org, flags.out ?? join("reports", `all-${ts}`), flags.prometheus);
          break;
        }
        if (!flags.ref) usage();
        const dir = flags.out ?? defaultOut(flags.ref);
        await doAnalyze(flags.ref, dir, flags.prometheus);
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
