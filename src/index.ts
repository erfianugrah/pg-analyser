#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import pkg from "../package.json" with { type: "json" };
import { collect } from "./collect.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { render } from "./report/render.ts";
import { writeScraper } from "./scraper.ts";
import { makeTransport } from "./transport.ts";

const VERSION = pkg.version;

function usage(): never {
  console.log(`sbperf ${VERSION} - Supabase performance analysis

Usage:
  sbperf analyze  --ref <ref> [--out <dir>]   fetch all planes -> analysis.json
  sbperf report   <dir>                       analysis.json -> report.html
  sbperf pdf      <dir>                        analysis.json -> report.pdf
  sbperf full     --ref <ref> [--out <dir>]    analyze + report + pdf
  sbperf scrape-init --ref <ref> [--dir <d>]   write the Prometheus+Grafana stack

Transport (auto-detected from env; see .env.example):
  direct      SUPABASE_ACCESS_TOKEN
  gatekeeper  GATEKEEPER_URL + GATEKEEPER_KEY`);
  process.exit(1);
}

function parseFlags(argv: string[]): { _: string[]; ref?: string; out?: string; dir?: string } {
  const out: { _: string[]; ref?: string; out?: string; dir?: string } = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--ref") out.ref = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--dir") out.dir = argv[++i];
    else if (a?.startsWith("--")) usage();
    else if (a) out._.push(a);
  }
  return out;
}

function defaultOut(ref: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return join("reports", `${ref}-${ts}`);
}

async function doAnalyze(ref: string, outDir: string): Promise<string> {
  const transport = makeTransport(loadConfig());
  console.error(`> analyzing ${ref} via ${transport.kind} transport`);
  const analysis = await collect(ref, transport, VERSION);
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
  const raw = await Bun.file(join(dir, "analysis.json")).json();
  return Analysis.parse(raw);
}

async function doReport(dir: string): Promise<string> {
  const analysis = await loadAnalysis(dir);
  const html = render(analysis);
  const htmlPath = join(dir, "report.html");
  await Bun.write(htmlPath, html);
  console.error(`> ${htmlPath}`);
  return htmlPath;
}

async function doPdf(dir: string): Promise<string> {
  const analysis = await loadAnalysis(dir);
  const html = render(analysis);
  const { htmlToPdf } = await import("./report/pdf.ts");
  const pdfPath = join(dir, "report.pdf");
  await htmlToPdf(html, pdfPath);
  console.error(`> ${pdfPath}`);
  return pdfPath;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const flags = parseFlags(argv.slice(1));

  try {
    switch (cmd) {
      case "analyze": {
        if (!flags.ref) usage();
        await doAnalyze(flags.ref, flags.out ?? defaultOut(flags.ref));
        break;
      }
      case "report": {
        const dir = flags._[0];
        if (!dir) usage();
        await doReport(dir);
        break;
      }
      case "pdf": {
        const dir = flags._[0];
        if (!dir) usage();
        await doPdf(dir);
        break;
      }
      case "full": {
        if (!flags.ref) usage();
        const dir = flags.out ?? defaultOut(flags.ref);
        await doAnalyze(flags.ref, dir);
        await doReport(dir);
        await doPdf(dir);
        console.error(`> done: ${dir}`);
        break;
      }
      case "scrape-init": {
        if (!flags.ref) usage();
        const dir = await writeScraper(flags.ref, loadConfig(), flags.dir ?? "scraper-live");
        console.error(`> wrote scraper stack to ${dir} - cd there and 'docker compose up -d'`);
        break;
      }
      default:
        usage();
    }
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`config error: ${err.message}`);
    } else {
      console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    }
    process.exit(1);
  }
}

await main();
