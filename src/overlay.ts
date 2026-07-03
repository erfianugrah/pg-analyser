import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

/**
 * Human review overlay: presentation-only inputs merged into the report at
 * render time. Keyed by project ref so a reviewer's choices (hide noisy
 * sections, append commentary) survive report regeneration. NEVER affects
 * analysis.json, the SQL layer, or the narrate input - it only curates what
 * report.html/report.pdf display. Mirrors brand.ts loadBrand() precedence.
 */

/** Drill-section ids in src/report/render.ts that a reviewer may hide. */
export const HIDEABLE_SECTIONS = [
  "rls",
  "outliers",
  "calls",
  "tables",
  "unused",
  "dupidx",
  "rlsunindexed",
  "seqscan",
  "bloat",
  "traffic",
  "deadtuples",
  "roles",
  "txid",
  "slots",
  "connections",
  "longrunning",
  "locks",
  "blocking",
  "functions",
  "storage",
  "apivol",
  "metrics",
] as const;

export type SectionId = (typeof HIDEABLE_SECTIONS)[number];
const HIDEABLE = new Set<string>(HIDEABLE_SECTIONS);

/** The on-disk overlay file shape. Strict: unknown keys fail loud. */
export const OverlayFile = z
  .object({
    hide: z.array(z.string()).optional(),
    notes: z.record(z.string(), z.string()).optional(),
  })
  .strict();

/** Resolved, validated overlay handed to the renderer. */
export interface Overlay {
  hide: Set<string>;
  /** section id (or "top") -> markdown note. */
  notes: Record<string, string>;
}

export const EMPTY_OVERLAY: Overlay = { hide: new Set(), notes: {} };

/**
 * Resolve a project's overlay by precedence:
 *   opts.file (--overlay) > SBPERF_OVERLAY > ./sbperf.overlays/<ref>.json >
 *   ~/.sbperf/overlays/<ref>.json > empty.
 * IO is injectable for tests. Unknown hide ids warn (advisory) and are dropped.
 */
export async function loadOverlay(
  opts: {
    ref?: string;
    file?: string;
    cwd?: string;
    home?: string;
    env?: Record<string, string | undefined>;
    readText?: (path: string) => Promise<string>;
    exists?: (path: string) => Promise<boolean>;
    warn?: (msg: string) => void;
  } = {},
): Promise<Overlay> {
  const env = opts.env ?? process.env;
  const readText = opts.readText ?? ((p) => Bun.file(p).text());
  const exists = opts.exists ?? ((p) => Bun.file(p).exists());
  const warn = opts.warn ?? ((m) => console.error(m));
  const cwd = opts.cwd ?? ".";
  const home = opts.home ?? homedir();

  // A path the caller named (--overlay flag or SBPERF_OVERLAY) is explicit: a
  // parse error there is a mistake the user wants to hear about loudly. A path
  // we auto-discovered by the ref convention is best-effort: one stray/typo'd
  // file must not abort a `full --all` sweep, so we warn and fall back to empty
  // (matching collect.ts's tolerant per-source ethos).
  let path = opts.file ?? env.SBPERF_OVERLAY;
  const explicit = Boolean(path);
  if (!path && opts.ref) {
    const local = join(cwd, "sbperf.overlays", `${opts.ref}.json`);
    const global = join(home, ".sbperf", "overlays", `${opts.ref}.json`);
    if (await exists(local)) path = local;
    else if (await exists(global)) path = global;
  }
  if (!path) return { hide: new Set(), notes: {} };

  let raw: z.infer<typeof OverlayFile>;
  try {
    raw = OverlayFile.parse(JSON.parse(await readText(path)));
  } catch (err) {
    if (explicit) throw err;
    warn(
      `sbperf: ignoring malformed overlay ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { hide: new Set(), notes: {} };
  }
  const hide = new Set<string>();
  for (const id of raw.hide ?? []) {
    if (HIDEABLE.has(id)) hide.add(id);
    else warn(`sbperf: overlay hide[] has unknown section id '${id}' (ignored)`);
  }
  const notes: Record<string, string> = {};
  for (const [key, val] of Object.entries(raw.notes ?? {})) {
    if (key === "top" || HIDEABLE.has(key)) notes[key] = val;
    else warn(`sbperf: overlay notes has unknown section id '${key}' (ignored)`);
  }
  return { hide, notes };
}
