import { existsSync } from "node:fs";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentsPages, fillContentsPages, pdfDestPages } from "./pdfpages.ts";

/** Max PDF renders: one numberless pass, then up to two with page numbers filled in. */
export const MAX_PDF_PASSES = 3;

/**
 * Render a self-contained HTML string to PDF via a headless Chrome/Chromium
 * found on the system. No Playwright dependency - keeps the compiled binary
 * standalone and small. Page geometry is controlled by the report's `@page`
 * CSS rule, which headless `--print-to-pdf` honours.
 *
 * The printed contents need real page numbers but Chromium has no CSS
 * target-counter(), so this renders twice or more: pass 1 prints the empty
 * page slots, the PDF's named destinations are mapped to page numbers
 * (pdfpages.ts), the numbers are injected and the page is printed again until
 * no contents entry changes page (cap MAX_PDF_PASSES). Any failure after
 * pass 1 keeps the previous PDF and logs a warning; it never fails the PDF.
 * Resolves to the number of renders performed.
 *
 * Discovery order: PG_ANALYSER_CHROME env, then a Playwright-installed
 * chrome-headless-shell, then common system binaries on PATH, then the
 * macOS app bundles.
 */
export async function htmlToPdf(html: string, outPath: string): Promise<number> {
  const chrome = await findChrome();
  if (!chrome) {
    throw new Error(
      "no Chrome/Chromium found. Install chromium, or set PG_ANALYSER_CHROME=/path/to/chrome",
    );
  }
  const dir = await mkdtemp(join(tmpdir(), "pg-analyser-"));
  try {
    await printOnce(chrome, dir, html, outPath);
    let passes = 1;
    let current = fillContentsPages(html, null);
    for (; passes < MAX_PDF_PASSES; ) {
      let pages: Map<string, number>;
      try {
        pages = pdfDestPages(await Bun.file(outPath).bytes());
      } catch (err) {
        console.error(`warn: PDF contents page numbers skipped: ${errMsg(err)}`);
        return passes;
      }
      const next = fillContentsPages(html, pages);
      const stable = passes > 1 && sameNumbers(contentsPages(current), contentsPages(next));
      if (stable || next === current) return passes;
      // Keep the last good PDF if a later pass fails.
      const tmpOut = `${outPath}.pass${passes + 1}`;
      try {
        await printOnce(chrome, dir, next, tmpOut);
        await rename(tmpOut, outPath);
      } catch (err) {
        await rm(tmpOut, { force: true });
        console.error(`warn: PDF contents page numbers skipped: ${errMsg(err)}`);
        return passes;
      }
      current = next;
      passes++;
    }
    return passes;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function sameNumbers(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

async function printOnce(
  chrome: string,
  dir: string,
  html: string,
  outPath: string,
): Promise<void> {
  const htmlPath = join(dir, "report.html");
  await Bun.write(htmlPath, html);
  const proc = Bun.spawn(chromePrintArgs(chrome, outPath, htmlPath), {
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0 || !existsSync(outPath)) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`chrome print-to-pdf failed (exit ${code}): ${err.slice(0, 300)}`);
  }
}

/**
 * The headless print command line. `--generate-pdf-document-outline` writes
 * PDF bookmarks from the heading elements (verified on Chromium 153 and
 * chrome-headless-shell 145-151): the report's group `<h1 class=ghead>` and
 * section `<h2>` headings become a two-level outline.
 */
export function chromePrintArgs(chrome: string, outPath: string, htmlPath: string): string[] {
  return [
    chrome,
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--no-pdf-header-footer",
    "--generate-pdf-document-outline",
    `--print-to-pdf=${outPath}`,
    `file://${htmlPath}`,
  ];
}

async function findChrome(): Promise<string | null> {
  const env = process.env.PG_ANALYSER_CHROME;
  if (env && existsSync(env)) return env;

  // Playwright-installed chrome-headless-shell (if the user has playwright elsewhere).
  const cache = join(process.env.HOME ?? "", ".cache/ms-playwright");
  if (existsSync(cache)) {
    const glob = new Bun.Glob(
      "chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell",
    );
    for await (const hit of glob.scan({ cwd: cache, absolute: true })) {
      if (existsSync(hit)) return hit;
    }
  }

  for (const bin of [
    "chromium",
    "chromium-browser",
    "google-chrome",
    "google-chrome-stable",
    "chrome",
  ]) {
    const which = Bun.which(bin);
    if (which) return which;
  }

  for (const app of chromeAppCandidates(process.platform, process.env.HOME ?? "")) {
    if (existsSync(app)) return app;
  }
  return null;
}

/**
 * Fixed install paths that a PATH lookup cannot see. On macOS Chrome ships as
 * an app bundle whose binary is never on PATH, so an installed browser read
 * as "no Chrome found" until these were added.
 */
export function chromeAppCandidates(platform: string, home: string): string[] {
  if (platform !== "darwin") return [];
  const bundles = [
    "Google Chrome.app/Contents/MacOS/Google Chrome",
    "Chromium.app/Contents/MacOS/Chromium",
  ];
  return [
    ...bundles.map((b) => `/Applications/${b}`),
    ...bundles.map((b) => join(home, "Applications", b)),
  ];
}
