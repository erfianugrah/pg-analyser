#!/usr/bin/env bun
/**
 * Advisor-lint catalog drift-check (advisory). The per-lint remediation catalog
 * in src/lints.ts (plain title + concrete fix + SQL + verify) must stay aligned
 * with the set of lints the Supabase Advisor actually emits. We already vendor
 * that lint set in src/splinter.sql, so this is a LOCAL consistency check (no
 * network): it extracts every `'<name>' as name` lint from splinter.sql and
 * diffs it against LINT_FIXES.
 *
 *   bun run scripts/check-lints-drift.ts        # warn on drift, exit 0
 *   SBPERF_LINTS_STRICT=1 bun run ...           # exit 1 on drift (gated job)
 *
 * Advisory by design: an uncatalogued lint still renders (findings.ts falls back
 * to the lint's own description + doc URL + dashboard deep-link), so a missing
 * entry degrades gracefully rather than breaking. The warning is the nudge to
 * add a concrete fix. A stale catalog key (no longer in splinter) is also warned.
 */

import { LINT_FIXES } from "../src/lints.ts";

const IN_GHA = process.env.GITHUB_ACTIONS === "true";
const STRICT = process.env.SBPERF_LINTS_STRICT === "1";
const warn = (m: string): void => console.error(IN_GHA ? `::warning::${m}` : `warning: ${m}`);

const splinterPath = new URL("../src/splinter.sql", import.meta.url).pathname;
const sql = await Bun.file(splinterPath).text();

// Splinter emits each lint's bare identifier as `'<name>' as name`.
const upstream = new Set<string>();
for (const m of sql.matchAll(/'([a-z0-9_]+)'\s+as\s+name/g)) upstream.add(m[1]!);

if (upstream.size === 0) {
  warn(`no lint names found in ${splinterPath} - has the splinter format changed?`);
  process.exit(STRICT ? 1 : 0);
}

const catalog = new Set(Object.keys(LINT_FIXES));
const missing = [...upstream].filter((n) => !catalog.has(n)).sort();
const stale = [...catalog].filter((n) => !upstream.has(n)).sort();

if (!missing.length && !stale.length) {
  console.error(`lint catalog in sync with splinter.sql (${upstream.size} lints)`);
  process.exit(0);
}

if (missing.length)
  warn(
    `${missing.length} splinter lint(s) missing from src/lints.ts LINT_FIXES ` +
      `(they render with the generic fallback - add a concrete fix): ${missing.join(", ")}`,
  );
if (stale.length)
  warn(
    `${stale.length} LINT_FIXES entr(y/ies) no longer in splinter.sql ` +
      `(rename or remove): ${stale.join(", ")}`,
  );

process.exit(STRICT ? 1 : 0);
