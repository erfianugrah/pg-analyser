# Report Overlay Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a human reviewer hide evidence sections and append markdown commentary per project, as render-time inputs that survive report regeneration.

**Architecture:** A ref-keyed JSON overlay (`hide` + `notes`), zod-validated at the boundary, loaded with `loadBrand`-style precedence and merged into the deterministic renderer. Overlay is presentation-only: `analysis.json` (the corpus) is never touched, `narrate` is unaffected, and re-rendering without the overlay restores the full report. `drill()` is the single choke-point for all ~22 evidence sections, so hide/note logic lives in one local wrapper.

**Tech Stack:** Bun + TypeScript (strict), zod 4, biome 2, `bun test`. Reuses `src/report/markdown.ts` (`mdToHtml`) for note rendering and mirrors `src/brand.ts` (`loadBrand`) for file precedence.

---

## Context the implementer needs

- The report is regenerated on every `analyze`/`snapshot`+`report` run, so human edits must be **inputs**, not edits of the generated `report.html`. The overlay is keyed by project `ref` (available at `analysis.meta.ref`) and lives outside the dated report dir, so it applies to every future render of that project.
- Presentation-only. Do NOT filter/curate `analysis.json`, `narrate` input, or the SQL layer. Hiding a section only removes it from `report.html`/`report.pdf`.
- Follow existing patterns: zod schema for the file (`OverlayFile`), injectable IO in the loader for tests (see `loadBrand` in `src/brand.ts:81`), `console.error` for advisory warnings (loud-but-tolerant, like the drift checks).
- v1 hideable ids are the `drill()` section ids only. Findings, advisors, exec-summary, scorecard, trends header are NOT hideable (they are the point of the report). `trends` is a top-level section, not a `drill()`, so it is out of scope for `hide` in v1.

### Decisions locked for v1
- **Format:** JSON (matches `sbperf.brand.json`; no YAML dep). Notes are markdown strings; `\n` for line breaks. `@file` note indirection is a fast-follow, not v1.
- **Persistence:** gitignore `sbperf.overlays/` (per-project commentary may reference customer context; mirror the `sbperf.brand.json` ignore + `.example` precedent). The global convention path is `~/.sbperf/overlays/<ref>.json`.
- **Precedence:** `--overlay <file>` (single-project `report`/`pdf` only) > `SBPERF_OVERLAY` env > `./sbperf.overlays/<ref>.json` > `~/.sbperf/overlays/<ref>.json` > empty.
- **Out of scope (fast-follows):** `findings` annotations (ack/wontfix/comment); `@file` note indirection; tool-proposed overlays from workload-shape ("context-driven"); Quarto `--emit-qmd` export; overlay support in `summary.html`/`narrative.html`.

### Canonical hideable section ids (the `drill()` ids in `src/report/render.ts`)
`rls, outliers, calls, tables, unused, dupidx, rlsunindexed, seqscan, bloat, traffic, deadtuples, roles, txid, slots, connections, longrunning, locks, blocking, functions, storage, apivol, metrics`

Note keys additionally accept `top` (injected after the executive summary).

---

## File Structure

- **Create `src/overlay.ts`** - `Overlay` type, `OverlayFile` zod schema, `HIDEABLE_SECTIONS` registry, `loadOverlay()` with precedence + validation. One responsibility: resolve and validate a project's overlay.
- **Create `test/overlay.test.ts`** - unit tests for schema, id validation, precedence.
- **Modify `src/report/render.ts`** - `render()` gains `opts.overlay`; rename module `drill` -> `baseDrill`; add a local `drill` closure that honours hide + appends notes; inject the `top` note; export `HIDEABLE_SECTIONS` re-export not needed (import from overlay).
- **Modify `test/render.test.ts`** - hide removes a section; note renders into a section; top note renders; no-overlay output unchanged.
- **Modify `src/index.ts`** - `--overlay` flag; thread overlay into `doReport`, `doPdf`, `emitReport` by `analysis.meta.ref`.
- **Modify `.gitignore`** - ignore `sbperf.overlays/`.
- **Create `sbperf.overlay.example.json`** - documented example.
- **Modify `AGENTS.md`** - document the overlay in the render bounded-context blurb + the hideable-id list.

---

## Task 1: Overlay module (schema + loader)

**Files:**
- Create: `src/overlay.ts`
- Test: `test/overlay.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/overlay.test.ts
import { describe, expect, test } from "bun:test";
import { HIDEABLE_SECTIONS, loadOverlay, OverlayFile } from "../src/overlay.ts";

// In-memory IO harness mirroring the loadBrand test style.
function harness(files: Record<string, string>) {
  return {
    readText: async (p: string) => {
      const v = files[p];
      if (v === undefined) throw new Error(`no such file ${p}`);
      return v;
    },
    exists: async (p: string) => p in files,
  };
}

describe("OverlayFile schema", () => {
  test("accepts hide + notes", () => {
    const o = OverlayFile.parse({ hide: ["outliers"], notes: { top: "hi" } });
    expect(o.hide).toEqual(["outliers"]);
    expect(o.notes?.top).toBe("hi");
  });
  test("rejects unknown top-level keys", () => {
    expect(() => OverlayFile.parse({ bogus: 1 })).toThrow();
  });
});

describe("loadOverlay", () => {
  const warns: string[] = [];
  const warn = (m: string) => warns.push(m);

  test("no ref and no file -> empty overlay", async () => {
    const o = await loadOverlay({ ...harness({}), warn });
    expect(o.hide.size).toBe(0);
    expect(o.notes).toEqual({});
  });

  test("explicit --overlay file wins over ref conventions", async () => {
    const io = harness({
      "/x/custom.json": JSON.stringify({ hide: ["calls"] }),
      "sbperf.overlays/abc.json": JSON.stringify({ hide: ["outliers"] }),
    });
    const o = await loadOverlay({ ref: "abc", file: "/x/custom.json", cwd: ".", ...io, warn });
    expect([...o.hide]).toEqual(["calls"]);
  });

  test("local ref convention beats global home path", async () => {
    const io = harness({
      "sbperf.overlays/abc.json": JSON.stringify({ hide: ["outliers"] }),
      "/home/u/.sbperf/overlays/abc.json": JSON.stringify({ hide: ["calls"] }),
    });
    const o = await loadOverlay({ ref: "abc", cwd: ".", home: "/home/u", ...io, warn });
    expect([...o.hide]).toEqual(["outliers"]);
  });

  test("unknown hide id is dropped with a warning", async () => {
    const local: string[] = [];
    const io = harness({ "sbperf.overlays/abc.json": JSON.stringify({ hide: ["nope", "outliers"] }) });
    const o = await loadOverlay({ ref: "abc", cwd: ".", ...io, warn: (m) => local.push(m) });
    expect([...o.hide]).toEqual(["outliers"]);
    expect(local.some((m) => m.includes("nope"))).toBe(true);
  });

  test("HIDEABLE_SECTIONS contains the query sections", () => {
    expect(HIDEABLE_SECTIONS).toContain("outliers");
    expect(HIDEABLE_SECTIONS).toContain("calls");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/overlay.test.ts`
Expected: FAIL (cannot resolve `../src/overlay.ts`).

- [ ] **Step 3: Write the module**

```ts
// src/overlay.ts
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

  let path = opts.file ?? env.SBPERF_OVERLAY;
  if (!path && opts.ref) {
    const local = join(cwd, "sbperf.overlays", `${opts.ref}.json`);
    const global = join(home, ".sbperf", "overlays", `${opts.ref}.json`);
    if (await exists(local)) path = local;
    else if (await exists(global)) path = global;
  }
  if (!path) return { hide: new Set(), notes: {} };

  const raw = OverlayFile.parse(JSON.parse(await readText(path)));
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/overlay.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Typecheck + lint**

Run: `bun run typecheck && bun run check`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/overlay.ts test/overlay.test.ts
git commit -m "feat(overlay): ref-keyed report overlay schema + loader"
```

---

## Task 2: Wire the overlay into the renderer

**Files:**
- Modify: `src/report/render.ts` (`drill` at 293; `render` signature at 561; the `sections` template around 617-668)
- Test: `test/render.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/render.test.ts - add to the existing describe block.
// Assumes a fixture Analysis is already available in this file (reuse the
// existing one; name it `a` here or adapt to the file's helper).
import { render } from "../src/report/render.ts";
import type { Overlay } from "../src/overlay.ts";

test("overlay hides a section", () => {
  const base = render(a);
  expect(base).toContain('id="outliers"');
  const overlay: Overlay = { hide: new Set(["outliers"]), notes: {} };
  const html = render(a, { overlay });
  expect(html).not.toContain('id="outliers"');
  // sibling section unaffected
  expect(html).toContain('id="calls"');
});

test("overlay appends a section note as rendered markdown", () => {
  const overlay: Overlay = { hide: new Set(), notes: { outliers: "**cron only**" } };
  const html = render(a, { overlay });
  const seg = html.slice(html.indexOf('id="outliers"'), html.indexOf('id="calls"'));
  expect(seg).toContain("<strong>cron only</strong>");
});

test("overlay top note renders after the exec summary", () => {
  const overlay: Overlay = { hide: new Set(), notes: { top: "reviewed today" } };
  const html = render(a, { overlay });
  expect(html).toContain("overlay-note");
  expect(html).toContain("reviewed today");
});

test("no overlay leaves output identical to default", () => {
  expect(render(a, { overlay: { hide: new Set(), notes: {} } })).toBe(render(a));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/render.test.ts`
Expected: FAIL (`render` ignores `overlay`; outliers still present).

- [ ] **Step 3: Rename the module `drill` to `baseDrill`**

In `src/report/render.ts:293`, rename only the declaration:

```ts
function baseDrill(id: string, title: string, note: string, body: string): string {
  return `<details open id="${id}"><summary><span class=h2>${esc(title)}</span>${note ? ` <span class=note>${esc(note)}</span>` : ""}</summary>${body}</details>`;
}
```

Leave every `drill(...)` call site in the `sections` template UNCHANGED - they will resolve to the local closure added in Step 4.

- [ ] **Step 4: Add the overlay to `render` and a local `drill` closure**

In `src/report/render.ts`, update the import block near the top:

```ts
import { EMPTY_OVERLAY, type Overlay } from "../overlay.ts";
```

Change the `render` signature (line 561) and add the closure + top-note injection. The signature:

```ts
export function render(
  a: Analysis,
  opts: { narrative?: boolean; brand?: Brand; overlay?: Overlay } = {},
): string {
```

Immediately after the existing `opts` destructuring / near the top of the body (before `const sections = ...`), add:

```ts
  const overlay = opts.overlay ?? EMPTY_OVERLAY;
  // Local drill: honour the reviewer overlay (hide sections, append notes)
  // while leaving the 22 call sites in the template unchanged.
  const drill = (id: string, title: string, note: string, body: string): string => {
    if (overlay.hide.has(id)) return "";
    const withNote = overlay.notes[id]
      ? `${body}<div class="overlay-note">${mdToHtml(overlay.notes[id])}</div>`
      : body;
    return baseDrill(id, title, note, withNote);
  };
```

Inject the `top` note right after the executive summary in the `sections`
template (the line is `${execSummarySection(a, findings, positives, degraded, narrativeHtml)}`):

```ts
${execSummarySection(a, findings, positives, degraded, narrativeHtml)}
${overlay.notes.top ? `<section class="overlay-note">${mdToHtml(overlay.notes.top)}</section>` : ""}
```

- [ ] **Step 5: Add minimal CSS for `overlay-note`**

Find the `<style>` block in `render.ts` and add one rule (match the existing note/aside styling; adjust selector to the file's conventions):

```css
.overlay-note{border-left:3px solid var(--accent);padding:.4rem .8rem;margin:.6rem 0;background:#f6f8fa}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test test/render.test.ts`
Expected: PASS (hide removes section; note renders; top note present; no-overlay identical).

- [ ] **Step 7: Full test + typecheck + lint**

Run: `bun test && bun run typecheck && bun run check`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add src/report/render.ts test/render.test.ts
git commit -m "feat(overlay): honour hide + notes in the renderer via drill choke-point"
```

---

## Task 3: Thread the overlay through the CLI

**Files:**
- Modify: `src/index.ts` (`Flags` type at 98; `parseFlags` at 122; usage text ~75; `emitReport` at 168; `doReport` ~656; `doPdf` ~678; their call sites)

- [ ] **Step 1: Add the `--overlay` flag**

In the `Flags` type (line 98 block) add:

```ts
  overlay?: string;
```

In `parseFlags` (near the `--brand` line 149) add:

```ts
    else if (a === "--overlay") out.overlay = argv[++i];
```

In the usage string (near line 75) add a line:

```
  --overlay <file>     per-project review overlay JSON (hide sections + notes;
                       default: ./sbperf.overlays/<ref>.json or ~/.sbperf/overlays/<ref>.json)
```

- [ ] **Step 2: Import the loader**

At the top of `src/index.ts`, next to the `loadBrand` import (line 5):

```ts
import { loadOverlay } from "./overlay.ts";
```

- [ ] **Step 3: Thread into `emitReport` (multi-project full/all path)**

`emitReport` has no `--overlay` (that is single-project only); it uses the
per-ref convention. Replace the render line (176):

```ts
  const overlay = await loadOverlay({ ref: analysis.meta.ref });
  const html = render(analysis, { brand: activeBrand, overlay });
```

- [ ] **Step 4: Thread into `doReport` and `doPdf`**

Add an `overlayFile?: string` parameter to both, and load by ref. `doReport`:

```ts
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
```

`doPdf`:

```ts
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
```

- [ ] **Step 5: Pass `flags.overlay` at the call sites**

Find where `doReport(` and `doPdf(` are dispatched in `main` (search
`doReport(` / `doPdf(`). Add `flags.overlay` as the new trailing argument,
matching each existing call's argument list. Example shape:

```ts
await doReport(dir, flags.store, flags.narrative, flags.overlay);
await doPdf(dir, flags.narrative, flags.store, flags.overlay);
```

(Adjust to the exact existing argument order at each site.)

- [ ] **Step 6: Typecheck + full test + lint**

Run: `bun run typecheck && bun test && bun run check`
Expected: all green.

- [ ] **Step 7: Live smoke test**

```bash
# pick an existing report dir with an analysis.json; read its ref
DIR=$(ls -d reports/all-*/*/*/ | head -1)
REF=$(bun -e "console.log(JSON.parse(await Bun.file(process.argv[1]).text()).meta.ref)" "$DIR/analysis.json")
mkdir -p sbperf.overlays
printf '{"hide":["outliers","calls"],"notes":{"top":"Reviewed - query sections omitted (all pg_cron)."}}' > "sbperf.overlays/$REF.json"
bun run src/index.ts report "$DIR"
grep -c 'id="outliers"' "$DIR/report.html"   # expect 0
grep -c 'overlay-note' "$DIR/report.html"     # expect >=1
rm "sbperf.overlays/$REF.json"
bun run src/index.ts report "$DIR"
grep -c 'id="outliers"' "$DIR/report.html"   # expect 1 (restored)
```

Expected: sections vanish with the overlay, restore without it, top note present.

- [ ] **Step 8: Commit**

```bash
git add src/index.ts
git commit -m "feat(overlay): --overlay flag + per-ref overlay on report/pdf/full paths"
```

---

## Task 4: gitignore, example, docs

**Files:**
- Modify: `.gitignore`
- Create: `sbperf.overlay.example.json`
- Modify: `AGENTS.md`

- [ ] **Step 1: Ignore overlays (reviewer content; mirror sbperf.brand.json)**

Append to `.gitignore` under the brand block:

```
# per-project review overlays (may reference customer context; keep the .example)
sbperf.overlays/
```

- [ ] **Step 2: Write the example**

```json
// sbperf.overlay.example.json
{
  "hide": ["outliers", "calls"],
  "notes": {
    "top": "Reviewed 2026-07-03. Query outlier sections omitted - this project's workload is entirely pg_cron scheduled jobs, not user-facing.",
    "infra": "Provisioned at this tier deliberately for the nightly batch window."
  }
}
```

(Rename to `sbperf.overlays/<ref>.json` per project, or pass with `--overlay`.)

- [ ] **Step 3: Document in AGENTS.md**

In the `report/render` bounded-context bullet, add a sentence:

```
overlay.ts    ref-keyed review overlay (hide sections + append markdown notes),
              loaded with loadBrand-style precedence and merged at render time;
              presentation-only (never touches analysis.json or narrate). Hideable
              ids are the drill() section ids. Overlays gitignored (keep .example).
```

- [ ] **Step 4: Commit**

```bash
git add .gitignore sbperf.overlay.example.json AGENTS.md
git commit -m "docs(overlay): gitignore overlays, add example + AGENTS note"
```

---

## Self-Review checklist (run before handing off to execution)

1. **Spec coverage:** hide sections (Task 2/3), append notes incl. `top` (Task 2), per-project persistence via ref (Task 1/3), `--overlay` + env + convention precedence (Task 1/3), presentation-only (no analysis/SQL/narrate changes anywhere), lossless restore (Task 3 smoke test). Covered.
2. **Placeholder scan:** no TBD/TODO; all code shown; the only "adjust to exact argument order" is the CLI call-site step, which is unavoidable local variance and has an example shape.
3. **Type consistency:** `Overlay { hide: Set<string>; notes: Record<string,string> }`, `EMPTY_OVERLAY`, `HIDEABLE_SECTIONS`, `loadOverlay(opts)` names match across Tasks 1-3; `render(a, { overlay })` matches the closure use; `baseDrill`/local `drill` split is internal to render.ts.

## Verification (final)

```bash
bun run typecheck && bun test && bun run check
```
All green, plus the Task 3 live smoke test confirming hide -> restore.
