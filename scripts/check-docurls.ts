#!/usr/bin/env bun
/**
 * Doc-reference drift-check (advisory). Every finding carries layered references
 * - a primary Supabase actionable `docUrl`, optional `refs[]` (Postgres
 * mechanism + AWS infra), and an optional `changelogUrl`. These rot silently
 * when upstream renames or removes a page, so this asserts every URL in the
 * catalog still resolves 200 AND lands on the path it names (a redirect to a
 * different path means the doc was renamed - repoint it).
 *
 *   bun run scripts/check-docurls.ts        # warn on dead / renamed, exit 0
 *   SBPERF_DOCURLS_STRICT=1 bun run ...      # exit 1 on any problem (gated job)
 *
 * Network-dependent, so advisory by default (offline CI shouldn't fail on it).
 * Mirrors check:api / check:lints: the warning is the nudge to fix the pointer.
 */

import { HEURISTICS } from "../src/heuristics.ts";
import { LINT_FIXES } from "../src/lints.ts";

const IN_GHA = process.env.GITHUB_ACTIONS === "true";
const STRICT = process.env.SBPERF_DOCURLS_STRICT === "1";
const warn = (m: string): void => console.error(IN_GHA ? `::warning::${m}` : `warning: ${m}`);

// Collect every URL in the catalog, remembering which finding(s) reference it.
const refs = new Map<string, Set<string>>();
const add = (url: string | undefined, owner: string): void => {
  if (!url) return;
  const set = refs.get(url) ?? new Set<string>();
  set.add(owner);
  refs.set(url, set);
};
for (const [id, h] of Object.entries(HEURISTICS)) {
  add(h.docUrl, id);
  add(h.changelogUrl, id);
  for (const r of h.refs ?? []) add(r.url, `${id}/${r.tier}`);
}
for (const [name, f] of Object.entries(LINT_FIXES)) {
  const anyF = f as { docUrl?: string; changelogUrl?: string };
  add(anyF.docUrl, `lint:${name}`);
  add(anyF.changelogUrl, `lint:${name}`);
}

// Path portion of a URL, normalised (no fragment, no trailing slash) for the
// renamed-doc comparison. Query string kept (e.g. ?lint=0009_duplicate_index).
const pathKey = (u: string): string => {
  try {
    const x = new URL(u);
    return `${x.host}${x.pathname.replace(/\/$/, "")}${x.search}`;
  } catch {
    return u;
  }
};

async function check(url: string): Promise<{ code: number; finalPath: string }> {
  // Strip the fragment for the request (server never sees it).
  const reqUrl = url.split("#")[0]!;
  try {
    const res = await fetch(reqUrl, { redirect: "follow", signal: AbortSignal.timeout(25_000) });
    return { code: res.status, finalPath: pathKey(res.url) };
  } catch (e) {
    return { code: 0, finalPath: `(${(e as Error).message})` };
  }
}

const urls = [...refs.keys()].sort();
console.error(`check:docurls - probing ${urls.length} URLs across the finding catalog...`);

let dead = 0;
let renamed = 0;
const results = await Promise.all(urls.map(async (u) => ({ u, ...(await check(u)) })));
for (const { u, code, finalPath } of results) {
  const owners = [...(refs.get(u) ?? [])].sort().join(", ");
  if (code !== 200) {
    dead++;
    warn(`DEAD (${code}) ${u}\n    referenced by: ${owners}`);
    continue;
  }
  if (pathKey(u) !== finalPath) {
    renamed++;
    warn(`RENAMED ${u}\n    -> now redirects to ${finalPath}\n    referenced by: ${owners}`);
  }
}

if (dead === 0 && renamed === 0) {
  console.error(`ok - all ${urls.length} doc references resolve 200 on their named path`);
  process.exit(0);
}
console.error(`\n${dead} dead, ${renamed} renamed of ${urls.length} doc references`);
process.exit(STRICT ? 1 : 0);
