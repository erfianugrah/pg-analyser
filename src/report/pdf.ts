import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Render a self-contained HTML string to PDF via a headless Chrome/Chromium
 * found on the system. No Playwright dependency - keeps the compiled binary
 * standalone and small. Page geometry is controlled by the report's `@page`
 * CSS rule, which headless `--print-to-pdf` honours.
 *
 * Discovery order: SBPERF_CHROME env, then a Playwright-installed
 * chrome-headless-shell, then common system binaries.
 */
export async function htmlToPdf(html: string, outPath: string): Promise<void> {
  const chrome = await findChrome();
  if (!chrome) {
    throw new Error(
      "no Chrome/Chromium found. Install chromium, or set SBPERF_CHROME=/path/to/chrome",
    );
  }

  const dir = await mkdtemp(join(tmpdir(), "sbperf-"));
  const htmlPath = join(dir, "report.html");
  try {
    await Bun.write(htmlPath, html);
    const proc = Bun.spawn(
      [
        chrome,
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        "--no-pdf-header-footer",
        `--print-to-pdf=${outPath}`,
        `file://${htmlPath}`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const code = await proc.exited;
    if (code !== 0 || !existsSync(outPath)) {
      const err = await new Response(proc.stderr).text();
      throw new Error(`chrome print-to-pdf failed (exit ${code}): ${err.slice(0, 300)}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function findChrome(): Promise<string | null> {
  const env = process.env.SBPERF_CHROME;
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
  return null;
}
