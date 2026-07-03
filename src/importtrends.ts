import type { TrendSeries } from "./schemas.ts";
import { TrendSeries as TrendSeriesSchema } from "./schemas.ts";

/**
 * Import externally-sourced time series into `analysis.trends` so the report
 * renders them as native inline-SVG trend panels - no vendor coupling. You
 * export whatever history you have (Grafana "Inspect -> Data -> Download CSV",
 * a Prometheus dump, a spreadsheet) and hand sbperf the file; it maps onto the
 * generic TrendSeries shape ({title, unit, points:[{t,v}]}). sbperf never talks
 * to your dashboard - it only ingests a file you produced.
 *
 * Supported formats:
 *  - CSV (wide): first column is time, every other column is one series (the
 *    header is its title). This is Grafana's default time-series CSV export.
 *    A "Title [unit]" or "Title (unit)" header sets the series unit.
 *  - CSV (long): exactly three columns (time, series, value) - the Prometheus /
 *    tidy-data shape. Detected by header names (series/metric/name + value) or
 *    by sniffing (col 2 is a non-numeric label, col 3 numeric). Grouped into one
 *    series per distinct label.
 *  - JSON: a TrendSeries[] (sbperf-native), or {trends:[...]}, or an array of
 *    {title, unit?, points:[{t,v}]} / {title, unit?, points:[[t,v],...]}.
 *
 * Timestamps may be ISO-8601 or epoch (seconds or milliseconds); all are
 * normalised to unix seconds (what TrendSeries.points.t uses).
 */

/** Normalise a timestamp cell (ISO-8601 | epoch s | epoch ms) to unix seconds. */
export function toEpochSeconds(raw: string | number): number | null {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return null;
    return raw >= 1e12 ? Math.round(raw / 1000) : Math.round(raw);
  }
  const s = raw.trim();
  if (!s) return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    return n >= 1e12 ? Math.round(n / 1000) : Math.round(n);
  }
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : Math.round(ms / 1000);
}

/** Split a "Title [unit]" / "Title (unit)" header into {title, unit}. */
function splitUnit(header: string): { title: string; unit: string } {
  const m = header.trim().match(/^(.*?)[\s]*[[(]([^\])]+)[\])]$/);
  if (m?.[1] && m[2]) return { title: m[1].trim(), unit: m[2].trim() };
  return { title: header.trim(), unit: "" };
}

const num = (cell: string): number | null => {
  const s = cell.replace(/,/g, "").trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/** Minimal RFC-4180-ish CSV: handles quoted fields with commas/quotes. */
function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQ = false;
  const src = text.replace(/\r\n?/g, "\n");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQ) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

const LONG_SERIES_HEADERS = new Set(["series", "metric", "name", "label", "key"]);
const LONG_VALUE_HEADERS = new Set(["value", "val", "v", "y"]);

/**
 * Decide whether a 3-column table is LONG (time, series, value) rather than WIDE
 * (time + two series columns). Prefer the header names; otherwise sniff - long
 * data has a non-numeric category in column 1 and numbers in column 2.
 */
function isLongFormat(rows: string[][]): boolean {
  const header = rows[0]!;
  if (header.length !== 3) return false;
  const h1 = header[1]!.trim().toLowerCase();
  const h2 = header[2]!.trim().toLowerCase();
  if (LONG_SERIES_HEADERS.has(h1) && LONG_VALUE_HEADERS.has(h2)) return true;
  // Sniff the data: col1 mostly non-numeric (series labels), col2 mostly numeric.
  const data = rows.slice(1);
  if (!data.length) return false;
  let col1NonNumeric = 0;
  let col2Numeric = 0;
  for (const r of data) {
    if (num(r[1] ?? "") == null && (r[1] ?? "").trim() !== "") col1NonNumeric++;
    if (num(r[2] ?? "") != null) col2Numeric++;
  }
  return col1NonNumeric > data.length / 2 && col2Numeric > data.length / 2;
}

/** Long format: (time, series, value) rows grouped into one series per label. */
function parseTrendsCsvLong(rows: string[][]): TrendSeries[] {
  const byName = new Map<string, TrendSeries>();
  for (const r of rows.slice(1)) {
    const t = toEpochSeconds(r[0] ?? "");
    const name = (r[1] ?? "").trim();
    const v = num(r[2] ?? "");
    if (t == null || !name || v == null) continue;
    const { title, unit } = splitUnit(name);
    let s = byName.get(title);
    if (!s) {
      s = { title, unit, points: [] };
      byName.set(title, s);
    }
    s.points.push({ t, v });
  }
  return [...byName.values()].filter((s) => s.points.length > 0);
}

export function parseTrendsCsv(text: string): TrendSeries[] {
  const rows = parseCsvRows(text);
  if (rows.length < 2) return [];
  const header = rows[0]!;
  if (header.length < 2) return [];
  if (isLongFormat(rows)) return parseTrendsCsvLong(rows);
  const cols = header.slice(1).map(splitUnit);
  const series: TrendSeries[] = cols.map((c) => ({ title: c.title, unit: c.unit, points: [] }));
  for (const r of rows.slice(1)) {
    const t = toEpochSeconds(r[0] ?? "");
    if (t == null) continue;
    for (let i = 0; i < series.length; i++) {
      const v = num(r[i + 1] ?? "");
      if (v != null) series[i]!.points.push({ t, v });
    }
  }
  return series.filter((s) => s.points.length > 0);
}

export function parseTrendsJson(text: string): TrendSeries[] {
  const raw = JSON.parse(text);
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { trends?: unknown[] }).trends)
      ? (raw as { trends: unknown[] }).trends
      : [];
  const out: TrendSeries[] = [];
  for (const item of list) {
    const s = item as { title?: unknown; unit?: unknown; points?: unknown };
    if (typeof s.title !== "string" || !Array.isArray(s.points)) continue;
    const points: { t: number; v: number }[] = [];
    for (const p of s.points) {
      // accept {t,v} objects or [t,v] tuples
      const tRaw = Array.isArray(p) ? p[0] : (p as { t?: unknown }).t;
      const vRaw = Array.isArray(p) ? p[1] : (p as { v?: unknown }).v;
      const t = toEpochSeconds(tRaw as string | number);
      const v = Number(vRaw);
      if (t != null && Number.isFinite(v)) points.push({ t, v });
    }
    if (points.length) {
      out.push({ title: s.title, unit: typeof s.unit === "string" ? s.unit : "", points });
    }
  }
  // Validate against the canonical schema before returning.
  return out.map((s) => TrendSeriesSchema.parse(s));
}

/** Dispatch by extension, falling back to a content sniff. */
export function parseTrendsFile(name: string, text: string): TrendSeries[] {
  const lower = name.toLowerCase();
  if (lower.endsWith(".json")) return parseTrendsJson(text);
  if (lower.endsWith(".csv") || lower.endsWith(".tsv")) return parseTrendsCsv(text);
  return text.trimStart().startsWith("[") || text.trimStart().startsWith("{")
    ? parseTrendsJson(text)
    : parseTrendsCsv(text);
}

/**
 * Merge incoming series into existing trends. A same-title incoming series
 * REPLACES the existing one (re-importing an updated export is idempotent);
 * new titles are appended.
 */
export function mergeTrends(existing: TrendSeries[], incoming: TrendSeries[]): TrendSeries[] {
  const byTitle = new Map(existing.map((s) => [s.title, s]));
  for (const s of incoming) byTitle.set(s.title, s);
  return [...byTitle.values()];
}
