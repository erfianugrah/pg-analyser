import { type Brand, brandVars, DEFAULT_BRAND, faviconTag } from "../brand.ts";
import {
  deriveFindings,
  derivePositives,
  type Finding,
  type Positive,
  type Severity,
} from "../findings.ts";
import { THRESHOLDS } from "../heuristics.ts";
import { EMPTY_OVERLAY, type Overlay } from "../overlay.ts";
import type { Advisor, Analysis, SqlRow } from "../schemas.ts";
import { mdToHtml } from "./markdown.ts";

/** Header block: brand logo + title, shared by every rendered page. */
function brandHead(brand: Brand, title: string): string {
  return `<div class=brandhead><span class=logo>${brand.logoSvg}</span><h1>${esc(title)}</h1></div>`;
}
const BRAND_CSS =
  ".brandhead{display:flex;align-items:center;gap:10px}.brandhead .logo svg{height:28px;width:auto;display:block}.brandhead h1{margin:0}";

/**
 * Shared theme tokens + dark-mode override for every rendered page. Colours flow
 * through CSS custom properties so a single prefers-color-scheme block flips the
 * whole report; scoped to `screen` so print/PDF always stays light. In dark mode
 * links use the (bright) brand accent for contrast.
 */
function themeVars(brand: Brand): string {
  return `:root{--fg:#1a1a1a;--mut:#666;--line:#ddd;--bg:#fff;--panel:#f6f6f6;--stripe:#fafafa;--code:#f2f2f2;--track:#eee;--spark:#fafafa;--lvlinfo:#e6f0ff;${brandVars(brand)};--okbg:#e3f4e3;--warnbg:#fff4d6;--errbg:#fde2e2}
  @media screen and (prefers-color-scheme:dark){:root{--fg:#e7e8ea;--mut:#9aa1aa;--line:#2b2f36;--bg:#16181c;--panel:#1d2026;--stripe:#191c21;--code:#22262d;--track:#2b2f36;--spark:#191c21;--lvlinfo:#1d2b45;--okbg:#16351f;--warnbg:#3a3410;--errbg:#3a1d1d;--link:var(--accent)}}`;
}

const esc = (s: unknown): string =>
  String(s ?? "").replace(
    /[&<>]/g,
    (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[m] as string,
  );

/** Advisor text is markdown with backslash-escaped backticks; unescape for display. */
const cleanText = (s: unknown): string => esc(String(s ?? "").replace(/\\`/g, "`"));

const bytes = (n: number | null): string => {
  if (n == null) return "-";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
};

function sqlTable(
  rows: SqlRow[],
  opts: { mono?: string[]; limit?: number; hide?: string[] } = {},
): string {
  if (!rows.length) return `<p class=empty>none found</p>`;
  const cols = Object.keys(rows[0]!).filter((c) => !opts.hide?.includes(c));
  const shown = opts.limit ? rows.slice(0, opts.limit) : rows;
  const mono = new Set(opts.mono ?? []);
  const th = cols.map((c) => `<th>${esc(c)}</th>`).join("");
  const body = shown
    .map(
      (r) =>
        "<tr>" +
        cols.map((c) => `<td${mono.has(c) ? " class=mono" : ""}>${esc(r[c])}</td>`).join("") +
        "</tr>",
    )
    .join("");
  const more =
    opts.limit && rows.length > opts.limit
      ? `<p class=empty>+${rows.length - opts.limit} more rows</p>`
      : "";
  return `<table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>${more}`;
}

/** A single inline-SVG horizontal bar (self-contained, print-safe). */
function barSvg(frac: number): string {
  const w = 150;
  const h = 11;
  const bw = Math.max(1, Math.round(Math.max(0, Math.min(1, frac)) * w));
  return `<svg class=bar width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><rect width="${w}" height="${h}" fill="var(--track)"/><rect width="${bw}" height="${h}" fill="var(--accent)"/></svg>`;
}

/**
 * Inline-SVG horizontal bar chart from SQL rows. `label` is truncated mono text,
 * bar width is value/max, and `display` is the formatted number at the end. No
 * external assets - one <svg> rect per row.
 */
function barChart(
  rows: SqlRow[],
  opts: {
    labelKey: string;
    valueKey: string;
    display: (r: SqlRow) => string;
    limit?: number;
    labelChars?: number;
  },
): string {
  const top = (opts.limit ? rows.slice(0, opts.limit) : rows).filter(
    (r) => Number(r[opts.valueKey]) > 0,
  );
  if (!top.length) return "";
  const max = Math.max(...top.map((r) => Number(r[opts.valueKey]) || 0), 1);
  const chars = opts.labelChars ?? 70;
  const body = top
    .map((r) => {
      const v = Number(r[opts.valueKey]) || 0;
      const label = String(r[opts.labelKey] ?? "").slice(0, chars);
      return `<tr><td class=mono>${esc(label)}</td><td class=barcell>${barSvg(v / max)}</td><td class=num>${esc(opts.display(r))}</td></tr>`;
    })
    .join("");
  return `<table class=chart><tbody>${body}</tbody></table>`;
}

/** barChart, but "" when the source errored (avoids a chart of stale/empty rows). */
function chartFor(rows: SqlRow[], errored: boolean, opts: Parameters<typeof barChart>[1]): string {
  return errored ? "" : barChart(rows, opts);
}

const LEVEL_ORDER: Record<string, number> = { ERROR: 0, WARN: 1, INFO: 2 };
function advisorTable(list: Advisor[]): string {
  if (!list.length) return `<p class=empty>no findings</p>`;
  const sorted = [...list].sort(
    (a, b) => (LEVEL_ORDER[a.level] ?? 9) - (LEVEL_ORDER[b.level] ?? 9),
  );
  const rows = sorted
    .map(
      (a) => `<tr>
      <td><span class="lvl ${esc(a.level)}">${esc(a.level)}</span></td>
      <td>${esc(a.title)}</td>
      <td>${cleanText(a.detail ?? a.description)}</td>
      <td>${a.remediation ? `<a href="${esc(a.remediation)}">docs</a>` : ""}</td>
    </tr>`,
    )
    .join("");
  return `<table class=adv><thead><tr><th>level</th><th>finding</th><th>detail</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}

function pgSettingsTable(rows: SqlRow[]): string {
  if (!rows.length) return `<p class=empty>not collected</p>`;
  const body = rows
    .map(
      (r) =>
        `<tr><td class=mono>${esc(r.name)}</td><td class=mono>${esc(r.setting)}${r.unit ? ` ${esc(r.unit)}` : ""}</td></tr>`,
    )
    .join("");
  return `<table><thead><tr><th>parameter</th><th>value</th></tr></thead><tbody>${body}</tbody></table>`;
}

function rlsTable(rows: SqlRow[]): string {
  if (!rows.length) return `<p class=empty>no RLS policies</p>`;
  const sorted = [...rows].sort(
    (a, b) => Number(b.unwrapped_auth === true) - Number(a.unwrapped_auth === true),
  );
  const body = sorted
    .map(
      (r) => `<tr class="${r.unwrapped_auth === true ? "flag" : ""}">
      <td class=mono>${esc(r.table)}</td><td>${esc(r.policyname)}</td><td>${esc(r.cmd)}</td>
      <td>${r.unwrapped_auth === true ? '<span class="badge warn">per-row auth</span>' : '<span class="badge ok">ok</span>'}</td>
    </tr>`,
    )
    .join("");
  return `<table><thead><tr><th>table</th><th>policy</th><th>cmd</th><th>auth eval</th></tr></thead><tbody>${body}</tbody></table>`;
}

function functionsSection(a: Analysis): string {
  if (!a.functions.length) return "<p class=empty>none deployed</p>";
  const list = sqlTable(a.functions as unknown as SqlRow[], { mono: ["slug"], hide: ["id"] });
  if (!a.functionStats.length) return list;
  const stats = a.functionStats.map((s) => ({
    slug: s.slug,
    requests: s.requests,
    success: s.success,
    "4xx": s.clientErr,
    "5xx": s.serverErr,
    avg_ms: s.avgExecMs,
    max_ms: s.maxExecMs,
  }));
  return `${list}<p class=note>Invocation stats (last day)</p>${sqlTable(stats as unknown as SqlRow[], { mono: ["slug"] })}`;
}

const METRICS_GUIDE = "https://supabase.com/docs/guides/telemetry/metrics";

/**
 * Metrics are point-in-time (a single scrape), so a raw table of current values
 * has little standalone worth. What matters is (a) whether the endpoint is
 * actually scrapeable and (b) how to stand up real scraping for history. The
 * full corpus is still captured in analysis.json + the history store.
 */
function metricsStatus(a: Analysis): string {
  if (!a.metrics.available)
    return `<p class="empty warn-text">Metrics endpoint not reachable at collection (see notes). <a href="${METRICS_GUIDE}">How to enable and scrape it &#8599;</a></p>`;
  const n = a.metrics.samples.length;
  return `<p class=note>Endpoint reachable - ${n} metric families captured this run (full point-in-time corpus in analysis.json). A single scrape is not a trend; stand up Prometheus/Grafana for history. <a href="${METRICS_GUIDE}">Supabase metrics guide &#8599;</a></p>`;
}

/**
 * API request volume rolled up over the collected window: per-service totals
 * plus the peak bucket. The raw per-interval series is too granular to read;
 * the rollup answers "how much traffic, and when did it peak".
 */
function apiVolumeSummary(a: Analysis): string {
  const rows = a.apiCounts;
  if (!rows.length) return "<p class=empty>none</p>";
  const services = [
    ["auth", "total_auth_requests"],
    ["realtime", "total_realtime_requests"],
    ["rest", "total_rest_requests"],
    ["storage", "total_storage_requests"],
  ] as const;
  const totals: Record<string, number> = {};
  let peak = { ts: "", total: -1 };
  for (const r of rows) {
    let bucket = 0;
    for (const [name, key] of services) {
      const v = Number((r as Record<string, unknown>)[key]) || 0;
      totals[name] = (totals[name] ?? 0) + v;
      bucket += v;
    }
    if (bucket > peak.total) peak = { ts: r.timestamp, total: bucket };
  }
  const grand = services.reduce((sum, [name]) => sum + (totals[name] ?? 0), 0);
  const cells = services
    .filter(([name]) => (totals[name] ?? 0) > 0)
    .map(([name]) => `<tr><td>${name}</td><td>${(totals[name] ?? 0).toLocaleString()}</td></tr>`)
    .join("");
  const peakLine =
    peak.total > 0
      ? `<p class=note>Peak bucket: ${esc(peak.ts)} - ${peak.total.toLocaleString()} requests.</p>`
      : "";
  return `<p class=note>${grand.toLocaleString()} total requests over the collected window (${rows.length} buckets).</p><table><thead><tr><th>service</th><th>requests</th></tr></thead><tbody>${cells}</tbody></table>${peakLine}`;
}

const fmtVal = (v: number, unit: string): string =>
  unit === "bytes" ? bytes(v) : v < 10 ? v.toFixed(2) : String(Math.round(v));

/**
 * Inline SVG trend panel for one series - self-contained (no external assets),
 * Grafana-style: filled area under the line + last-point marker. viewBox
 * stretches to the panel width (preserveAspectRatio=none) so it fills the grid
 * cell; keep TEXT out of the SVG (it would distort) - labels live in the HTML
 * caption/footer.
 */
function sparkline(s: Analysis["trends"][number]): string {
  const w = 360;
  const h = 60;
  const pad = 6;
  const baseY = h - pad;
  const vals = s.points.map((p) => p.v);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min;
  const n = s.points.length;
  const last = s.points[n - 1]?.v ?? 0;
  const y = (v: number) => (span === 0 ? h / 2 : baseY - ((v - min) / span) * (h - 2 * pad));
  // A single sample has no line to draw - show a baseline + a dot so the panel
  // isn't an empty box; a flat series draws a flat mid-line.
  let shape: string;
  if (n <= 1) {
    const cx = (w / 2).toFixed(1);
    const cy = (h / 2).toFixed(1);
    shape = `<line x1="${pad}" y1="${h / 2}" x2="${w - pad}" y2="${h / 2}" stroke="var(--line)" stroke-width="1"/><circle cx="${cx}" cy="${cy}" r="3" fill="var(--link)"/>`;
  } else {
    const x = (i: number) => pad + (i / (n - 1)) * (w - 2 * pad);
    const pts = s.points.map((p, i) => `${x(i).toFixed(1)},${y(p.v).toFixed(1)}`);
    const line = `M${pts.join(" L")}`;
    const area = `M${x(0).toFixed(1)},${baseY} L${pts.join(" L")} L${x(n - 1).toFixed(1)},${baseY} Z`;
    const lastX = x(n - 1).toFixed(1);
    const lastY = y(last).toFixed(1);
    shape =
      `<path d="${area}" fill="var(--link)" fill-opacity="0.12" stroke="none"/>` +
      `<path d="${line}" fill="none" stroke="var(--link)" stroke-width="1.5"/>` +
      `<circle cx="${lastX}" cy="${lastY}" r="2.5" fill="var(--link)"/>`;
  }
  const range =
    span === 0
      ? `flat at ${esc(fmtVal(last, s.unit))}`
      : `${esc(fmtVal(min, s.unit))} - ${esc(fmtVal(max, s.unit))}`;
  // The actual data window, derived from the point timestamps (fetchTrends
  // auto-scopes to a young project's real span, so a 30d request can yield 7d
  // of data - label what's actually there, not the requested window).
  const spanSec = n >= 2 ? s.points[n - 1]!.t - s.points[0]!.t : 0;
  const windowLabel = spanSec > 0 ? `${fmtSpan(spanSec)} &middot; ` : "";
  return `<figure class=spark>
    <figcaption>${esc(s.title)} <b>${esc(fmtVal(last, s.unit))}</b></figcaption>
    <svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none">${shape}</svg>
    <span class=note>${range} &middot; ${windowLabel}${n} pt${n === 1 ? "" : "s"}</span>
  </figure>`;
}

/** Human span for a trend window: 45m / 18h / 7d / 31d. */
function fmtSpan(sec: number): string {
  const days = sec / 86400;
  if (days >= 1) return `${Math.round(days)}d`;
  const hours = sec / 3600;
  if (hours >= 1) return `${Math.round(hours)}h`;
  return `${Math.max(1, Math.round(sec / 60))}m`;
}

function trendsSection(a: Analysis): string {
  if (!a.trends.length) return "";
  return `<h2 id="trends">Resource snapshot <span class=note>infra over time - read for headroom vs cost (over-provisioned = downsize, near-ceiling = upsize). Single-point series show a marker until more snapshots accrue</span></h2>
<div class=sparks>${a.trends.map(sparkline).join("")}</div>`;
}

function healthBadges(a: Analysis): string {
  if (!a.health.length) return `<p class=empty>unavailable</p>`;
  return a.health
    .map(
      (h) =>
        `<span class="badge ${h.healthy ? "ok" : "bad"}">${esc(h.name)}: ${esc(h.status)}</span>`,
    )
    .join(" ");
}

const SEV_CLASS: Record<Severity, string> = { high: "ERROR", med: "WARN", low: "INFO" };

/** Upstream sync annotation for the footer - advisor lints are live regardless. */
function syncFooter(sync: Analysis["sync"]): string {
  if (!sync) return "";
  const flagged = sync.stale || sync.advisorSqlDrifted === true;
  const cls = flagged ? "warn-text" : "";
  return `<p class="meta ${cls}">Heuristics sync: ${esc(sync.note)} Live advisor lints (performance + security) are fetched per run and are always current.</p>`;
}

/** "What's looking good" - confirmed-healthy observations, only when present. */
function positivesSection(positives: Positive[]): string {
  if (!positives.length) return "";
  const items = positives
    .map((p) => `<li><b>${esc(p.category)}:</b> ${esc(p.title)}</li>`)
    .join("");
  return `<h2 id="healthy">What's looking good <span class=count>${positives.length}</span></h2>
<ul class="positives">${items}</ul>`;
}

/** Collapsible evidence section (open by default so PDF shows everything). */
function baseDrill(id: string, title: string, note: string, body: string): string {
  return `<details open id="${id}"><summary><span class=h2>${esc(title)}</span>${note ? ` <span class=note>${esc(note)}</span>` : ""}</summary>${body}</details>`;
}

// --- Audit front-page + deep-dive (TL;DR -> per-finding -> evidence) ---

const SEV_WORD: Record<Severity, string> = { high: "HIGH", med: "MED", low: "LOW" };
/** Stable id linking a TL;DR priority to its deep-dive block. */
const fid = (i: number) => `f${i + 1}`;

function computeVerdict(findings: Finding[], degraded: boolean): { cls: string; text: string } {
  const c = { high: 0, med: 0, low: 0 };
  for (const f of findings) c[f.severity]++;
  if (!findings.length)
    return degraded
      ? { cls: "warn", text: "No issues found, but some checks could not run" }
      : { cls: "ok", text: "Healthy - no issues found" };
  if (c.high)
    return {
      cls: "bad",
      text: `${c.high} issue${c.high === 1 ? " needs" : "s need"} attention now`,
    };
  return {
    cls: "warn",
    text: `${findings.length} issue${findings.length === 1 ? "" : "s"} worth reviewing`,
  };
}

/** Join titles into a readable clause: "a, b and c". */
function humanList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * Executive summary section - always present. When the LLM narrative exists it
 * IS the summary (richer prose); otherwise a deterministic, hedged synthesis
 * built from the verdict + counts + top areas (conversational, conditional
 * outcomes - never "will", never imperatives).
 */
function execSummarySection(
  a: Analysis,
  findings: Finding[],
  positives: Positive[],
  degraded: boolean,
  narrativeHtml: string,
): string {
  // The LLM narrative carries its own "## Executive summary" + section headings
  // and the #summary anchor, so render it as-is. Only the deterministic fallback
  // needs the wrapping h2.
  if (narrativeHtml) return narrativeHtml;
  const head = `<h2 id="summary">Executive summary</h2>`;
  const c = { high: 0, med: 0, low: 0 };
  for (const f of findings) c[f.severity]++;
  const total = findings.length;
  const named = (titles: string[]) => esc(humanList(titles));
  // The opening's count and the items it names MUST agree - the high-severity
  // count and a separate "top 3 areas" list previously contradicted each other
  // ("1 item stands out ... the areas are A, B and C"). Name the urgent item(s)
  // in the opening, then frame the remainder as an explicitly-counted bucket.
  let opening: string;
  if (!total) {
    opening = degraded
      ? "Some checks could not run, so this is a partial view - but nothing was flagged in what was collected."
      : "Overall the database is in good shape, with no issues surfaced across performance, security, and capacity checks.";
  } else if (c.high) {
    const highTitles = findings
      .filter((f) => f.severity === "high")
      .slice(0, 3)
      .map((f) => f.title);
    const others = total - c.high;
    const rest =
      others > 0
        ? ` A further ${others} lower-severity ${others === 1 ? "item is" : "items are"} worth reviewing when convenient.`
        : "";
    opening = `The database is largely healthy, though ${c.high} item${c.high === 1 ? "" : "s"} ${c.high === 1 ? "stands" : "stand"} out as worth attention sooner rather than later: ${named(highTitles)}.${rest}`;
  } else {
    const top = findings.slice(0, 3).map((f) => f.title);
    opening = `Overall the database is in good shape, with ${total} area${total === 1 ? "" : "s"} worth a closer look${top.length ? ` - starting with ${named(top)}` : ""}.`;
  }
  const healthy = positives.length
    ? ` ${positives.length} check${positives.length === 1 ? "" : "s"} came back healthy.`
    : "";
  const upside = total
    ? " Addressing them could ease load on the busiest paths and improve response times, and in many cases without scaling up the database."
    : "";
  return `${head}
<p class=execsum>${opening}${healthy}${upside}</p>`;
}

function severityBar(findings: Finding[]): string {
  if (!findings.length) return "";
  const c = { high: 0, med: 0, low: 0 };
  for (const f of findings) c[f.severity]++;
  const seg = (n: number, cls: string, lbl: string) =>
    n ? `<span class="segbar ${cls}" style="flex:${n}">${n} ${lbl}</span>` : "";
  return `<div class="sevbar">${seg(c.high, "ERROR", "high")}${seg(c.med, "WARN", "med")}${seg(c.low, "INFO", "low")}</div>`;
}

/** Numbered top-priority list; each entry jumps to its deep-dive block. */
function topPriorities(findings: Finding[]): string {
  if (!findings.length) return "";
  const li = findings
    .slice(0, 6)
    .map(
      (f, i) =>
        `<li><a href="#${fid(i)}"><span class="lvl ${SEV_CLASS[f.severity]}">${SEV_WORD[f.severity]}</span> ${esc(f.title)}</a></li>`,
    )
    .join("");
  return `<ol class=priorities>${li}</ol>`;
}

/** Per-finding deep-dive: what it is, how to fix (remediation + doc), evidence link. */
function auditFindings(findings: Finding[], degraded: boolean): string {
  if (!findings.length)
    return degraded
      ? `<p class="banner">No findings - but diagnostics were incomplete (see the status banner). Absence of findings is not proof the project is clean.</p>`
      : `<p class="banner ok">No issues detected across performance, security, and capacity checks.</p>`;
  return findings
    .map((f, i) => {
      const links = [
        f.docUrl ? `<a href="${esc(f.docUrl)}">Reference &#8599;</a>` : "",
        f.changelogUrl ? `<a href="${esc(f.changelogUrl)}">Changelog &#8599;</a>` : "",
        f.anchor ? `<a href="${esc(f.anchor)}">Evidence &#8595;</a>` : "",
      ]
        .filter(Boolean)
        .join(" &middot; ");
      // Inline bold labels read as a paragraph - cleaner hierarchy than the
      // cramped uppercase label grid, matching the audit-report house style.
      const leg = (label: string, text?: string) =>
        text ? `<p class=fleg><b class=flabel>${label}.</b> ${esc(text)}</p>` : "";
      const doText = esc(
        f.remediation ?? "See the linked evidence and the Supabase advisor detail.",
      );
      const sqlBlock = f.sql ? `<pre class=fsql><code>${esc(f.sql)}</code></pre>` : "";
      const dashLink = f.dashUrl
        ? `<p class=fadv><a href="${esc(f.dashUrl)}">Open in the ${esc(f.category)} Advisor: ${esc(f.dashUrl)}</a></p>`
        : "";
      const body =
        leg("What's happening", f.evidence) +
        leg("Why it matters", f.whyItMatters) +
        `<p class=fleg><b class=flabel>What to do.</b> ${doText}</p>${sqlBlock}${dashLink}` +
        leg("How to verify", f.howToVerify);
      return `<div class="finding ${SEV_CLASS[f.severity]}" id="${fid(i)}">
  <h3><span class="lvl ${SEV_CLASS[f.severity]}">${SEV_WORD[f.severity]}</span> <span class=fcat>${esc(f.category)}</span> ${esc(f.title)}</h3>
  <div class=fbody>${body}</div>
  ${links ? `<p class=flinks>${links}</p>` : ""}
</div>`;
    })
    .join("");
}

/** Latest disk-used% from the trend (the only disk-fill signal in no-PAT mode,
 * where the Management provisioning plane - size/IOPS - is absent). */
function diskUsedPctTrend(a: Analysis): number | null {
  const v = a.trends.find((t) => t.title === "Disk used (%)")?.points.at(-1)?.v;
  return v == null ? null : Math.round(v);
}

/** Compact vitals for the front page (full detail stays in Infrastructure). */
function vitalsMini(a: Analysis): string {
  const d = a.disk;
  const diskPct = diskUsedPctTrend(a);
  const rows: [string, string][] = [
    ["Postgres", esc(a.meta.pgVersion ?? "-")],
    ["DB size", esc(a.sql.dbSize ?? "-")],
    ["Cache hit", a.sql.cacheHitPct == null ? "-" : `${a.sql.cacheHitPct}%`],
    [
      "Disk used",
      d?.usedBytes != null
        ? `${bytes(d.usedBytes)} / ${bytes((d.usedBytes ?? 0) + (d.availBytes ?? 0))}`
        : diskPct != null
          ? `${diskPct}% of /data`
          : "-",
    ],
  ];
  return `<table class=vitals><tbody>${rows
    .map(([k, v]) => `<tr><td>${k}</td><td class=mono>${v}</td></tr>`)
    .join("")}</tbody></table>`;
}

export interface IndexRow {
  name: string;
  ref: string;
  status: string;
  high: number;
  med: number;
  low: number;
  dir: string;
  error?: string;
}

/** Org-level index page linking every project report. */
export function renderIndex(
  rows: IndexRow[],
  collectedAt: string,
  brand: Brand = DEFAULT_BRAND,
): string {
  const body = rows
    .map((r) => {
      const healthy = r.status === "ACTIVE_HEALTHY";
      const sev =
        r.error != null
          ? '<span class="lvl ERROR">ERROR</span>'
          : r.high > 0
            ? '<span class="lvl ERROR">high</span>'
            : r.med > 0
              ? '<span class="lvl WARN">med</span>'
              : '<span class="lvl INFO">low</span>';
      return `<tr>
      <td><a href="${esc(r.dir)}/report.html">${esc(r.name)}</a></td>
      <td class=mono>${esc(r.ref)}</td>
      <td><span class="badge ${healthy ? "ok" : "bad"}">${esc(r.status)}</span></td>
      <td>${r.error ? esc(r.error) : `${r.high} / ${r.med} / ${r.low}`}</td>
      <td>${sev}</td>
    </tr>`;
    })
    .join("");
  return `<!doctype html><html lang=en><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">${faviconTag(brand)}<title>sbperf - org report</title>
<style>
  ${themeVars(brand)}
  body{font:14px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;color:var(--fg);background:var(--bg);margin:0 auto;padding:24px;max-width:1000px}
  h1{font-size:20px;margin:0 0 4px}.meta{color:var(--mut);font-size:12px;margin-bottom:16px}
  ${BRAND_CSS}
  table{border-collapse:collapse;width:100%;font-size:13px}
  th,td{text-align:left;padding:5px 9px;border:1px solid var(--line)}
  th{background:var(--panel)}tbody tr:nth-child(even){background:var(--stripe)}
  td.mono{font-family:ui-monospace,Menlo,monospace;font-size:11.5px}
  .badge{font-size:11px;padding:1px 6px;border-radius:3px}.badge.ok{background:var(--okbg)}.badge.bad{background:var(--errbg)}
  .lvl{font-weight:700;font-size:11px;padding:1px 5px;border-radius:2px;color:#1a1a1a}
  .lvl.WARN{background:#ffe08a}.lvl.ERROR{background:#f7b0b0}.lvl.INFO{background:#a9c7ff}
  a{color:var(--link)}
</style></head><body>
${brandHead(brand, "Supabase performance - org report")}
<div class=meta>${rows.length} projects &middot; collected ${esc(collectedAt)} &middot; findings shown as high / med / low</div>
<table><thead><tr><th>project</th><th>ref</th><th>status</th><th>findings</th><th>top sev</th></tr></thead><tbody>${body}</tbody></table>
</body></html>`;
}

export interface OrgRow {
  name: string;
  dir: string;
  projects: number;
  high: number;
  med: number;
  low: number;
  errors: number;
}

/** Top-level org overview for `--all`: one row per org, linking its own index. */
export function renderOrgIndex(
  rows: OrgRow[],
  collectedAt: string,
  brand: Brand = DEFAULT_BRAND,
): string {
  const totalProjects = rows.reduce((s, r) => s + r.projects, 0);
  const body = rows
    .map((r) => {
      const sev =
        r.high > 0
          ? '<span class="lvl ERROR">high</span>'
          : r.med > 0
            ? '<span class="lvl WARN">med</span>'
            : '<span class="lvl INFO">low</span>';
      return `<tr>
      <td><a href="${esc(r.dir)}/index.html">${esc(r.name)}</a></td>
      <td>${r.projects}</td>
      <td>${r.high} / ${r.med} / ${r.low}</td>
      <td>${r.errors ? `<span class="lvl ERROR">${r.errors}</span>` : "0"}</td>
      <td>${sev}</td>
    </tr>`;
    })
    .join("");
  return `<!doctype html><html lang=en><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">${faviconTag(brand)}<title>sbperf - all organizations</title>
<style>
  ${themeVars(brand)}
  body{font:14px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;color:var(--fg);background:var(--bg);margin:0 auto;padding:24px;max-width:1000px}
  h1{font-size:20px;margin:0 0 4px}.meta{color:var(--mut);font-size:12px;margin-bottom:16px}
  ${BRAND_CSS}
  table{border-collapse:collapse;width:100%;font-size:13px}
  th,td{text-align:left;padding:5px 9px;border:1px solid var(--line)}
  th{background:var(--panel)}tbody tr:nth-child(even){background:var(--stripe)}
  .lvl{font-weight:700;font-size:11px;padding:1px 5px;border-radius:2px;color:#1a1a1a}
  .lvl.WARN{background:#ffe08a}.lvl.ERROR{background:#f7b0b0}.lvl.INFO{background:#a9c7ff}
  a{color:var(--link)}
</style></head><body>
${brandHead(brand, "Supabase performance - all organizations")}
<div class=meta>${rows.length} organization${rows.length === 1 ? "" : "s"} &middot; ${totalProjects} project${totalProjects === 1 ? "" : "s"} &middot; collected ${esc(collectedAt)} &middot; findings shown as high / med / low</div>
<table><thead><tr><th>organization</th><th>projects</th><th>findings</th><th>errors</th><th>top sev</th></tr></thead><tbody>${body}</tbody></table>
</body></html>`;
}

export function render(
  a: Analysis,
  opts: { narrative?: boolean; brand?: Brand; overlay?: Overlay } = {},
): string {
  const brand = opts.brand ?? DEFAULT_BRAND;
  const overlay = opts.overlay ?? EMPTY_OVERLAY;
  // Local drill: honour the reviewer overlay (hide sections, append notes)
  // while leaving the 22 call sites in the template unchanged.
  const drill = (id: string, title: string, note: string, body: string): string => {
    // A hidden section is dropped entirely - any note keyed to it goes with it.
    if (overlay.hide.has(id)) return "";
    const overlayNote = overlay.notes[id];
    const withNote = overlayNote
      ? `${body}<div class="overlay-note">${mdToHtml(overlayNote)}</div>`
      : body;
    return baseDrill(id, title, note, withNote);
  };
  const m = a.meta;
  const disk = a.disk;
  const narrativeHtml =
    opts.narrative && a.narrative
      ? `<div class=narrative id="summary">${mdToHtml(a.narrative)}</div>`
      : "";
  const errored = new Set(a.errors.map((e) => e.source));
  // Point-in-time snapshot sections carry no signal at rest, so gate them on
  // whether there is anything worth reading (empty = omit). Errored collection
  // still shows (so "not collected" is visible). Threshold-gated sections only
  // appear when they approach the threshold worth acting on.
  const show = {
    roles:
      errored.has("sql:roleStats") ||
      a.sql.roleStats.some((r) => {
        const c = Number(r.connections) || 0;
        const l = Number(r.conn_limit) || 0;
        return l > 0 && c / l >= THRESHOLDS.roleConnShowFrac;
      }),
    txid:
      errored.has("sql:txidWraparound") ||
      a.sql.txidWraparound.some((r) => (Number(r.pct_wraparound) || 0) >= THRESHOLDS.txidWarnPct),
    slots: a.sql.replicationSlots.length > 0,
    longrunning: a.sql.longRunning.length > 0,
    locks: a.sql.locks.length > 0,
    blocking: a.sql.blocking.length > 0,
    apivol: errored.has("apiCounts") || a.apiCounts.length > 0,
  };
  const findings = deriveFindings(a);
  const positives = derivePositives(a);

  // "not collected" (source errored) vs "none found" (collected, empty).
  // Key off the trivial dbSize probe: if that fails, the DB is unreachable;
  // a single fancy query failing does not mean the whole DB plane is down.
  const dbUnreachable = errored.has("sql:dbSize");
  const sec = (rows: SqlRow[], source: string, opts?: Parameters<typeof sqlTable>[1]) =>
    errored.has(source)
      ? `<p class="empty warn-text">not collected - see notes</p>`
      : sqlTable(rows, opts);

  // In no-PAT mode the project's status is simply unknown (no Management API),
  // which is NOT a degradation - full SQL diagnostics were still collected. Only
  // treat an unreachable DB as degraded there.
  const noPat = m.managementApi === false;
  const degraded = (!noPat && m.status !== "ACTIVE_HEALTHY") || dbUnreachable;
  const banner = noPat
    ? `<p class="banner ${dbUnreachable ? "bad" : "warn"}">No-PAT mode: diagnostics via superuser SQL (--db-url)${a.trends.length ? " + Grafana trends" : ""}; advisors via the self-hosted splinter lints. Management-API planes (compute/disk provisioning, backups, pooler config, metrics, edge/API analytics) were not collected - absent sections there mean "not available in this mode", not "clean".${dbUnreachable ? " The database was ALSO unreachable, so SQL diagnostics are missing too." : ""}</p>`
    : degraded
      ? `<p class="banner bad">Project status <b>${esc(m.status)}</b>${dbUnreachable ? " - database was unreachable" : ""}. Runtime diagnostics (queries, metrics, health) are unavailable; only static config was collected. Empty sections below mean "not collected", not "clean".</p>`
      : "";

  const diskLine = disk
    ? `${disk.sizeGb} GB ${esc(disk.type)} / ${disk.iops ?? "-"} IOPS / ${disk.throughputMibps ?? "-"} MiB/s`
    : "-";
  const diskPctTrend = diskUsedPctTrend(a);
  const diskUsed =
    disk && disk.usedBytes != null
      ? `used ${bytes(disk.usedBytes)} / ${bytes((disk.usedBytes ?? 0) + (disk.availBytes ?? 0))}`
      : diskPctTrend != null
        ? `${diskPctTrend}% of /data used (from trend; provisioning n/a without a PAT)`
        : "";
  const up = a.upgrade;
  const upgradeNote =
    up?.current_app_version &&
    up.latest_app_version &&
    up.current_app_version !== up.latest_app_version
      ? `<span class="badge warn">update available</span>`
      : up
        ? `<span class="badge ok">up to date</span>`
        : "";

  const statsWindow = a.sql.statsResetAge ? ` (over ${a.sql.statsResetAge.split(".")[0]})` : "";
  const outliersNote = `top 5 by share of DB time - app workload only; platform, migration, DDL and transaction-control statements filtered out${statsWindow}`;
  const verdict = computeVerdict(findings, degraded);
  const sections = `
<section class=tldr>
  <div class="verdict ${verdict.cls}">${esc(verdict.text)}</div>
  <div class=scorecard>
    <div class=sc-main>
      <div class=sc-label>${findings.length} finding${findings.length === 1 ? "" : "s"} &middot; ${positives.length} healthy check${positives.length === 1 ? "" : "s"}</div>
      ${severityBar(findings)}
      ${findings.length ? `<div class=sc-sub>Top priorities</div>${topPriorities(findings)}` : ""}
    </div>
    <div class=sc-vitals><div class=sc-sub>At a glance</div>${vitalsMini(a)}<p class=hbadges>${healthBadges(a)}</p></div>
  </div>
</section>
${execSummarySection(a, findings, positives, degraded, narrativeHtml)}${
  overlay.notes.top
    ? `
<section class="overlay-note">${mdToHtml(overlay.notes.top)}</section>`
    : ""
}

${trendsSection(a)}

${positivesSection(positives)}

<h2 id="findings">Findings worth addressing <span class=count>${findings.length}</span></h2>
${auditFindings(findings, degraded)}

<h2 id="evidence">Evidence &amp; drill-down</h2>
<p class=note>Substantiating data for every finding above - each finding's "Evidence" link lands in one of these sections.</p>

<h2 id="infra">Infrastructure</h2>
<table class=kv>
  <tr><td>Postgres version</td><td class=mono>${esc(m.pgVersion)}</td><td>${upgradeNote}</td></tr>
  <tr><td>Disk</td><td class=mono>${diskLine}</td><td>${diskUsed}</td></tr>
  <tr><td>DB size</td><td class=mono>${esc(a.sql.dbSize ?? (errored.has("sql:dbSize") ? "not collected" : "-"))}</td><td></td></tr>
  <tr><td>Cache hit (table)</td><td class=mono>${a.sql.cacheHitPct == null ? "-" : `${a.sql.cacheHitPct}%`}</td><td>${a.sql.cacheHitPct != null && a.sql.cacheHitPct < 99 ? '<span class="badge warn">below 99%</span>' : ""}</td></tr>
  <tr><td>Cache hit (index)</td><td class=mono>${a.sql.indexHitPct == null ? "-" : `${a.sql.indexHitPct}%`}</td><td>${a.sql.indexHitPct != null && a.sql.indexHitPct < 99 ? '<span class="badge warn">below 99%</span>' : ""}</td></tr>
  <tr><td>Stats window</td><td class=mono>${esc(a.sql.statsResetAge ? a.sql.statsResetAge.split(".")[0] : "-")}</td><td class=note>pg_stat_statements age; cache-hit/outliers are relative to this</td></tr>
</table>

<h2 id="config">PG tuning params</h2>${errored.has("sql:pgSettings") ? '<p class="empty warn-text">not collected</p>' : pgSettingsTable(a.sql.pgSettings)}

${drill("rls", "RLS policies", "auth.*() should be wrapped: (select auth.uid())", errored.has("sql:rlsPolicies") ? '<p class="empty warn-text">not collected - see notes</p>' : rlsTable(a.sql.rlsPolicies))}

<h2 id="adv-perf">Advisors - performance <span class=count>${a.advisors.performance.length}</span></h2>${errored.has("advisors:performance") ? '<p class="empty warn-text">not collected</p>' : advisorTable(a.advisors.performance)}
<h2 id="adv-sec">Advisors - security <span class=count>${a.advisors.security.length}</span></h2>${errored.has("advisors:security") ? '<p class="empty warn-text">not collected</p>' : advisorTable(a.advisors.security)}

${drill("outliers", "Query outliers", outliersNote, chartFor(a.sql.topStatements, errored.has("sql:topStatements"), { labelKey: "query", valueKey: "pct", display: (r) => `${r.pct}% (${r.total_ms}ms)`, limit: 5 }) + sec(a.sql.topStatements, "sql:topStatements", { mono: ["query"], limit: 5 }))}
${drill("calls", "Most-frequent queries", "top 5 by call count - chatty / hot-path app workload (platform/migration/DDL noise filtered)", chartFor(a.sql.topByCalls, errored.has("sql:topByCalls"), { labelKey: "query", valueKey: "pct_calls", display: (r) => `${r.pct_calls}% (${r.calls} calls)`, limit: 5 }) + sec(a.sql.topByCalls, "sql:topByCalls", { mono: ["query"], limit: 5 }))}
${drill("tables", "Biggest tables", "", sec(a.sql.biggestTables, "sql:biggestTables", { mono: ["table"], hide: ["schema"], limit: 20 }))}
${drill("unused", "Index usage", "all indexes by size; unused = never scanned, non-constraint", sec(a.sql.indexStats, "sql:indexStats", { mono: ["index", "table"], hide: ["schema"] }))}
${drill("dupidx", "Duplicate indexes", "identical index definitions on one table - keep one, drop the rest", errored.has("sql:duplicateIndexes") ? '<p class="empty warn-text">not collected</p>' : a.sql.duplicateIndexes.length ? sqlTable(a.sql.duplicateIndexes, { mono: ["indexes"], hide: ["schema"] }) : "<p class=empty>none found</p>")}
${drill("rlsunindexed", "RLS columns without an index", "policy-compared column with no covering index -> seq scan per row check", errored.has("sql:rlsUnindexed") ? '<p class="empty warn-text">not collected</p>' : a.sql.rlsUnindexed.length ? sqlTable(a.sql.rlsUnindexed, { mono: ["table", "column"], hide: ["schema"] }) : "<p class=empty>none found</p>")}
${drill("seqscan", "Sequential-scan heavy", "seq_scan > idx_scan, >1k rows", sec(a.sql.seqScanHeavy, "sql:seqScanHeavy", { mono: ["table"], hide: ["schema"] }))}
${drill("bloat", "Estimated bloat", "reclaimable wasted space (pg_stats estimate)", sec(a.sql.bloat, "sql:bloat", { mono: ["name"], hide: ["waste_bytes"] }))}
${drill("traffic", "Read/write profile", "per-table read-heavy vs write-heavy", sec(a.sql.trafficProfile, "sql:trafficProfile", { mono: ["table"] }))}
${drill("deadtuples", "Dead tuples / autovacuum", "overdue = dead tuples past the table's autovacuum threshold", sec(a.sql.deadTuples, "sql:deadTuples", { mono: ["table"], hide: ["schema"] }))}
${show.roles ? drill("roles", "Role connection usage", "active connections vs each role's limit (shown when a role nears its limit)", sec(a.sql.roleStats, "sql:roleStats", { mono: ["role"] })) : ""}
${show.txid ? drill("txid", "Transaction-ID wraparound", "age(relfrozenxid) vs 2B ceiling; shown when a table approaches the wraparound threshold", sec(a.sql.txidWraparound, "sql:txidWraparound", { mono: ["table"], hide: ["schema"] })) : ""}
${show.slots ? drill("slots", "Replication slots", "retained WAL; inactive slots pin disk", sqlTable(a.sql.replicationSlots, { mono: ["slot_name"], hide: ["retained_wal_bytes"] })) : ""}
${drill("connections", "Connections", "by state", sec(a.sql.connections, "sql:connections"))}
${show.longrunning ? drill("longrunning", "Long-running queries", "point-in-time snapshot: running > 5 min at collection", sqlTable(a.sql.longRunning, { mono: ["query"] })) : ""}
${show.locks ? drill("locks", "Exclusive locks", "point-in-time snapshot: relation-level strong locks at collection", sqlTable(a.sql.locks, { mono: ["query", "relation"] })) : ""}
${show.blocking ? drill("blocking", "Blocking chains", "point-in-time snapshot at collection", sqlTable(a.sql.blocking, { mono: ["blocked_query", "blocking_query"] })) : ""}
${drill("functions", "Edge functions", "invocation stats over the last day", functionsSection(a))}
${drill("storage", "Storage", "buckets + object usage", storageSection(a))}
${show.apivol ? drill("apivol", "API request volume", "rolled up over the collected window; peak bucket noted", errored.has("apiCounts") ? '<p class="empty warn-text">not collected</p>' : apiVolumeSummary(a)) : ""}
${drill("metrics", "Infra metrics", "scrape status + how to build history", metricsStatus(a))}
${a.errors.length ? `<h2>Collection notes <span class=count>${a.errors.length}</span></h2>${collectionNotes(a)}` : ""}
`;

  return `<!doctype html><html lang=en><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
${faviconTag(brand)}
<title>sbperf - ${esc(m.name)}</title>
<style>
  ${themeVars(brand)}
  ${BRAND_CSS}
  *{box-sizing:border-box}
  body{font:14px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;color:var(--fg);background:var(--bg);margin:0 auto;padding:24px;max-width:1200px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  h1{font-size:20px;margin:0 0 4px}
  h2,.h2{font-size:15px;font-weight:700}
  h2{margin:26px 0 6px;padding-bottom:3px;border-bottom:2px solid var(--fg)}
  details{margin:26px 0 0}
  summary{border-bottom:2px solid var(--fg);padding-bottom:3px;cursor:pointer;list-style-position:inside}
  summary .h2{margin-right:4px}
  .meta{color:var(--mut);font-size:12px;margin-bottom:8px}
  .meta code{background:var(--code);padding:1px 4px;border-radius:2px}
  .lead{font-weight:600;margin:6px 0}
  .banner{padding:8px 12px;border-radius:4px;font-size:13px;margin:8px 0}
  .banner.bad{background:var(--errbg)}.banner.ok{background:var(--okbg)}
  ul.positives{margin:6px 0;padding-left:20px;columns:2;column-gap:28px}
  ul.positives li{margin:2px 0;break-inside:avoid}
  .execsum{font-size:14px;line-height:1.55;margin:6px 0 4px}
  .narrative{font-size:13px;line-height:1.5;border-left:3px solid var(--accent);padding:2px 0 2px 14px;margin:8px 0}
  .narrative h2{font-size:14px;margin:14px 0 4px;border:none;padding:0}
  .narrative h3{font-size:13px;font-weight:700;margin:10px 0 2px}
  .narrative ul,.narrative ol{margin:4px 0;padding-left:22px}
  .overlay-note{border-left:3px solid var(--accent);padding:.4rem .8rem;margin:.6rem 0;background:var(--panel)}
  .narrative li{margin:2px 0}
  .narrative code{background:var(--code);padding:1px 4px;border-radius:2px;font-size:12px}
  .narrative pre{background:var(--code);padding:8px 10px;border-radius:3px;overflow:auto}
  .narrative pre code{background:none;padding:0}
  .sevbar{display:flex;height:20px;border-radius:3px;overflow:hidden;margin:6px 0 12px;max-width:460px;font-size:11px;font-weight:700}
  .segbar{display:flex;align-items:center;justify-content:center;color:#3a3a3a;padding:0 8px;white-space:nowrap}
  .segbar.ERROR{background:#f7b0b0}.segbar.WARN{background:#ffe08a}.segbar.INFO{background:#a9c7ff}
  /* --- audit front page (TL;DR) --- */
  section.tldr{margin:10px 0 26px}
  .verdict{padding:14px 18px;border-radius:6px;font-size:18px;font-weight:700;margin:0 0 16px}
  .verdict.ok{background:var(--okbg)}.verdict.warn{background:var(--warnbg)}.verdict.bad{background:var(--errbg)}
  .scorecard{display:grid;grid-template-columns:1fr 320px;gap:28px;align-items:start}
  .sc-label{font-size:13px;font-weight:600;color:var(--mut);margin-bottom:2px}
  .sc-sub{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;color:var(--mut);margin:14px 0 6px}
  ol.priorities{margin:0;padding-left:22px;font-size:14px}
  ol.priorities li{margin:5px 0}
  ol.priorities a{color:var(--fg);text-decoration:none}
  ol.priorities a:hover{text-decoration:underline}
  table.vitals{width:100%;border-collapse:collapse;font-size:13px}
  table.vitals td{padding:4px 8px;border:1px solid var(--line)}
  table.vitals td:first-child{color:var(--mut);width:90px}
  .hbadges{margin:12px 0 0;line-height:2}
  /* --- per-finding deep dive --- */
  .finding{border:1px solid var(--line);border-left-width:4px;border-radius:5px;padding:10px 14px;margin:10px 0;break-inside:avoid;page-break-inside:avoid}
  .finding.ERROR{border-left-color:#d64545}.finding.WARN{border-left-color:#d9a400}.finding.INFO{border-left-color:#5a7fd6}
  .finding h3{font-size:14px;margin:0 0 6px;font-weight:700;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .fcat{font-size:11px;font-weight:600;color:var(--mut);text-transform:uppercase;letter-spacing:.03em}
  p.fix{margin:0;font-size:13px;line-height:1.5}
  p.fix.empty{color:var(--mut)}
  .fbody{font-size:13px;line-height:1.55}
  .fleg{margin:0 0 5px}
  .flabel{font-weight:700;color:var(--fg)}
  pre.fsql{background:var(--code);border:1px solid var(--line);border-radius:4px;padding:8px 10px;margin:6px 0 0;overflow-x:auto;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;line-height:1.45;white-space:pre;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  pre.fsql code{background:none;padding:0;white-space:inherit;font-family:inherit}
  .fadv{margin-top:6px;font-size:12px;word-break:break-all}
  @keyframes sbflash{from{background:rgba(120,160,255,.30)}to{background:transparent}}
  :target{animation:sbflash 1.6s ease-out}
  h2:target,summary:target,.finding:target{box-shadow:-6px 0 0 0 var(--accent);border-radius:2px}
  @media print{pre.fsql{white-space:pre-wrap;word-break:break-word;overflow:visible}}
  p.flinks{margin:10px 0 0;padding-top:8px;border-top:1px solid var(--line);font-size:12.5px}
  p.flinks a{font-weight:600;color:var(--link);text-decoration:none}
  p.flinks a:hover{text-decoration:underline}
  table.chart{border:none;width:100%;margin:4px 0 8px;table-layout:fixed}
  table.chart{border-spacing:0}
  table.chart td{border:none;padding:3px 0;vertical-align:middle}
  table.chart td.mono{width:42%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;padding-right:20px}
  table.chart td.barcell{width:auto;padding-right:12px}
  table.chart td.num{width:130px;font-family:ui-monospace,Menlo,monospace;font-size:11px;white-space:nowrap;text-align:right;color:var(--mut)}
  svg.bar{display:block;width:100%}
  table{border-collapse:collapse;width:100%;font-size:12.5px;margin:2px 0}
  th,td{text-align:left;padding:4px 8px;border:1px solid var(--line);vertical-align:top}
  th{background:var(--panel);font-weight:600;white-space:nowrap}
  tbody tr:nth-child(even){background:var(--stripe)}
  tbody tr.flag{background:var(--warnbg)}
  td.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;white-space:pre-wrap;max-width:620px;word-break:break-word}
  table.kv{table-layout:fixed}
  table.kv td:first-child{white-space:nowrap;font-weight:600;width:130px}
  table.kv td:nth-child(3){width:34%;word-break:break-word}
  table.find td:first-child,table.find td:nth-child(2){white-space:nowrap;width:1%}
  .count{display:inline-block;background:var(--fg);color:var(--bg);border-radius:10px;padding:0 7px;font-size:11px;vertical-align:middle}
  .note{color:var(--mut);font-weight:400;font-size:12px}
  .empty{color:var(--mut);font-style:italic;margin:4px 0}
  .warn-text{color:#b8860b}
  .lvl{font-weight:700;font-size:11px;padding:1px 5px;border-radius:2px;color:#1a1a1a}
  .lvl.WARN{background:#ffe08a}.lvl.ERROR{background:#f7b0b0}.lvl.INFO{background:#a9c7ff}
  .badge{display:inline-block;font-size:11px;padding:1px 6px;border-radius:3px;background:var(--track)}
  .badge.ok{background:var(--okbg)}.badge.warn{background:var(--warnbg)}.badge.bad{background:var(--errbg)}
  table.adv td:nth-child(3){max-width:560px}
  a{color:var(--link)}
  .sparks{display:grid;grid-template-columns:repeat(3,1fr);gap:12px 16px;margin-top:8px}
  @media (max-width:900px){.sparks{grid-template-columns:repeat(2,1fr)}}
  @media (max-width:560px){.sparks{grid-template-columns:1fr}}
  figure.spark{margin:0}
  figure.spark figcaption{font-size:12px;font-weight:600;margin-bottom:3px}
  figure.spark svg{display:block;border:1px solid var(--line);background:var(--spark);border-radius:2px}
  figure.spark .note{display:block;margin-top:1px}
  @page{size:A4;margin:14mm 12mm}
  @media print{
    body{padding:0;max-width:none;font-size:11.5px}
    h1{font-size:17px}
    /* keep a heading with the content that follows it */
    h1,h2,.h2,summary{break-after:avoid;page-break-after:avoid;break-inside:avoid}
    /* repeat table headers on every page a long table spans */
    thead{display:table-header-group}
    tbody tr{break-inside:avoid;page-break-inside:avoid}
    /* never split these visual units across a page boundary */
    .banner,.lead,.sevbar,figure.spark,table.chart,ul.positives li,table.kv{break-inside:avoid;page-break-inside:avoid}
    details{break-inside:auto}
    p{orphans:3;widows:3}
    a{color:var(--fg);text-decoration:none}
  }
</style></head><body>
${brandHead(brand, "Supabase performance report")}
<div class=meta>
  <code>${esc(m.name)}</code> (${esc(m.ref)}) &middot; ${esc(m.region)} &middot;
  status <code>${esc(m.status)}</code> &middot;
  collected <code>${esc(m.collectedAt)}</code> &middot; sbperf <code>${esc(m.sbperfVersion)}</code>
</div>
${banner}
${sections}
<p class=meta style="margin-top:32px">Generated deterministically from ${
    m.managementApi === false
      ? `superuser SQL (--db-url) and the self-hosted splinter advisors${a.trends.length ? " + Grafana trends" : ""} (no-PAT mode)`
      : `the Supabase Management API, ${m.sqlSource === "superuser" ? "superuser SQL (--db-url)" : "read-only SQL"}, and the project metrics endpoint`
  }. No values inferred.</p>
${syncFooter(a.sync)}
</body></html>`;
}

/** Standalone narrative.html - the LLM narrative on its own page. */
export function renderNarrativePage(a: Analysis, brand: Brand = DEFAULT_BRAND): string {
  const m = a.meta;
  const body = a.narrative ? mdToHtml(a.narrative) : "<p>No narrative generated.</p>";
  return `<!doctype html><html lang=en><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
${faviconTag(brand)}
<title>sbperf narrative - ${esc(m.name)}</title>
<style>
  ${themeVars(brand)}
  body{font:15px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:var(--fg);background:var(--bg);margin:0 auto;padding:32px;max-width:80ch}
  h1{font-size:20px;margin:0 0 2px}
  .meta{color:var(--mut);font-size:12px;margin-bottom:20px}
  h2{font-size:16px;margin:20px 0 6px;border-bottom:2px solid var(--fg);padding-bottom:3px}
  h3{font-size:14px;margin:14px 0 3px}
  ul,ol{padding-left:22px}li{margin:3px 0}
  code{background:var(--code);padding:1px 4px;border-radius:2px;font-size:13px}
  pre{background:var(--code);padding:10px 12px;border-radius:3px;overflow:auto}pre code{background:none;padding:0}
  a{color:var(--link)}hr{border:none;border-top:1px solid var(--line);margin:16px 0}
  ${BRAND_CSS}
</style></head><body>
${brandHead(brand, "Supabase performance - narrative")}
<div class=meta><code>${esc(m.name)}</code> (${esc(m.ref)}) &middot; ${esc(m.region)} &middot; collected ${esc(m.collectedAt.slice(0, 10))} &middot; LLM synthesis over analysis.json (the deterministic report is ground truth)</div>
${body}
</body></html>`;
}

/**
 * Non-technical, one-page summary for a non-engineering audience. No SQL, no
 * evidence tables - a plain verdict, the issues in priority order, and a few
 * vitals in everyday terms. Companion to the full technical report.
 */
export function renderSummary(a: Analysis, brand: Brand = DEFAULT_BRAND): string {
  const m = a.meta;
  const findings = deriveFindings(a);
  const positives = derivePositives(a);
  const degraded = a.meta.status !== "ACTIVE_HEALTHY" || !a.metrics.available;
  const counts = { high: 0, med: 0, low: 0 };
  for (const f of findings) counts[f.severity]++;

  const verdict = computeVerdict(findings, degraded);

  const label: Record<Severity, string> = {
    high: "Needs attention now",
    med: "Worth reviewing",
    low: "Minor / housekeeping",
  };
  const groups = (["high", "med", "low"] as const)
    .map((sev) => {
      const items = findings.filter((f) => f.severity === sev);
      if (!items.length) return "";
      const li = items
        .map(
          (f) =>
            `<li><b>${esc(f.category)}:</b> ${esc(f.title)}${f.remediation ? `<div class=sfix>${esc(f.remediation)}</div>` : ""}</li>`,
        )
        .join("");
      return `<h2 class="g ${SEV_CLASS[sev]}">${label[sev]}</h2><ul>${li}</ul>`;
    })
    .join("");

  const cacheText =
    a.sql.cacheHitPct == null
      ? "not measured"
      : a.sql.cacheHitPct >= 99
        ? `${a.sql.cacheHitPct}% of reads served from memory (healthy)`
        : `${a.sql.cacheHitPct}% of reads served from memory (below the 99% target)`;

  const vitals = [
    ["Database size", esc(a.sql.dbSize ?? "not measured")],
    ["Read cache", cacheText],
    ["Postgres version", esc(m.pgVersion ?? "unknown")],
  ]
    .map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`)
    .join("");

  const goodBlock = positives.length
    ? `<h2 class="g INFO">What's working well</h2><ul>${positives
        .map((p) => `<li>${esc(p.title)}</li>`)
        .join("")}</ul>`
    : "";
  const body =
    (findings.length
      ? groups
      : `<p>All performance, security, and capacity checks passed${degraded ? ", though some data could not be collected (the project may be paused or unreachable)" : ""}.</p>`) +
    goodBlock;

  return `<!doctype html><html lang=en><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
${faviconTag(brand)}
<title>${esc(m.name)} - performance summary</title>
<style>
  ${themeVars(brand)}
  body{font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:var(--fg);background:var(--bg);margin:0 auto;padding:32px;max-width:760px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  h1{font-size:22px;margin:0 0 2px}
  ${BRAND_CSS}
  .meta{color:var(--mut);font-size:13px;margin-bottom:16px}
  .verdict{padding:14px 16px;border-radius:6px;font-size:17px;font-weight:600;margin:12px 0 20px}
  h2.g,ul,tr,.verdict{break-inside:avoid;page-break-inside:avoid}
  h2.g{page-break-after:avoid}
  .verdict.ok{background:var(--okbg)}.verdict.warn{background:var(--warnbg)}.verdict.bad{background:var(--errbg)}
  h2.g{font-size:14px;margin:20px 0 4px;padding:2px 8px;border-radius:3px;display:inline-block;color:#1a1a1a}
  h2.g.ERROR{background:#f7b0b0}h2.g.WARN{background:#ffe08a}h2.g.INFO{background:#a9c7ff}
  ul{margin:4px 0 0;padding-left:22px}li{margin:7px 0}
  .sfix{color:var(--mut);font-size:13px;margin-top:2px}
  table{border-collapse:collapse;width:100%;margin-top:8px;font-size:14px}
  td{padding:6px 10px;border:1px solid var(--line)}td:first-child{font-weight:600;width:180px}
  .foot{color:var(--mut);font-size:12px;margin-top:28px}
  @page{size:A4;margin:16mm}
</style></head><body>
${brandHead(brand, "Performance summary")}
<div class=meta>${esc(m.name)} &middot; ${esc(m.region)} &middot; ${esc(m.collectedAt.slice(0, 10))}</div>
<div class="verdict ${verdict.cls}">${esc(verdict.text)}</div>
${body}
<h2 class=g>At a glance</h2>
<table><tbody>${vitals}</tbody></table>
<p class=foot>Plain-language summary. A detailed technical report (report.html) accompanies this for the engineering team. Generated by sbperf ${esc(m.sbperfVersion)}.</p>
</body></html>`;
}

function storageSection(a: Analysis): string {
  if (!a.buckets.length) return `<p class=empty>no buckets</p>`;
  const usage = new Map<string, SqlRow>();
  for (const r of a.sql.storageUsage) usage.set(String(r.bucket_id), r);
  const body = a.buckets
    .map((b) => {
      const u = usage.get(b.name);
      return `<tr><td class=mono>${esc(b.name)}</td><td>${b.public ? '<span class="badge warn">public</span>' : '<span class="badge ok">private</span>'}</td><td>${esc(u?.objects ?? 0)}</td><td>${esc(u?.size ?? "0 bytes")}</td></tr>`;
    })
    .join("");
  return `<table><thead><tr><th>bucket</th><th>access</th><th>objects</th><th>size</th></tr></thead><tbody>${body}</tbody></table>`;
}

/** Dedup identical error messages (e.g. 8x connection-timeout) into one row + count. */
function collectionNotes(a: Analysis): string {
  const byMsg = new Map<string, { sources: string[]; message: string }>();
  for (const e of a.errors) {
    const g = byMsg.get(e.message) ?? { sources: [], message: e.message };
    g.sources.push(e.source);
    byMsg.set(e.message, g);
  }
  const rows = [...byMsg.values()]
    .map(
      (g) =>
        `<tr><td class=mono>${esc(g.sources.length > 3 ? `${g.sources.slice(0, 3).join(", ")} +${g.sources.length - 3}` : g.sources.join(", "))}</td><td>${esc(g.message)}${g.sources.length > 1 ? ` <span class=count>${g.sources.length}x</span>` : ""}</td></tr>`,
    )
    .join("");
  return `<table><thead><tr><th>source</th><th>message</th></tr></thead><tbody>${rows}</tbody></table>`;
}
