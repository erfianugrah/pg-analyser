import { z } from "zod";

/**
 * Report branding. Defaults to Supabase (logo + green colourway); anyone can
 * white-label via a brand file (--brand / SBPERF_BRAND / ./sbperf.brand.json),
 * overriding any subset of fields. Assets are inlined into the self-contained
 * report, so a logo is an SVG string (or a path we read at load time).
 *
 * The default Supabase mark is the official favicon (supabase.com/favicon).
 * Supabase's brand terms say the wordmark must not be recoloured, so the
 * default logo keeps its baked-in green regardless of the accent; a white-label
 * brand supplies its own logo.
 */

// Official Supabase mark; gradient ids prefixed to avoid collisions when inlined.
const SUPABASE_LOGO_SVG =
  '<svg viewBox="0 0 109 113" fill="none" xmlns="http://www.w3.org/2000/svg" aria-label="Supabase">' +
  '<path d="M63.7076 110.284C60.8481 113.885 55.0502 111.912 54.9813 107.314L53.9738 40.0627L99.1935 40.0627C107.384 40.0627 111.952 49.5228 106.859 55.9374L63.7076 110.284Z" fill="url(#sbp_a)"/>' +
  '<path d="M63.7076 110.284C60.8481 113.885 55.0502 111.912 54.9813 107.314L53.9738 40.0627L99.1935 40.0627C107.384 40.0627 111.952 49.5228 106.859 55.9374L63.7076 110.284Z" fill="url(#sbp_b)" fill-opacity="0.2"/>' +
  '<path d="M45.317 2.07103C48.1765 -1.53037 53.9745 0.442937 54.0434 5.041L54.4849 72.2922H9.83113C1.64038 72.2922 -2.92775 62.8321 2.1655 56.4175L45.317 2.07103Z" fill="#3ECF8E"/>' +
  "<defs>" +
  '<linearGradient id="sbp_a" x1="53.9738" y1="54.974" x2="94.1635" y2="71.8295" gradientUnits="userSpaceOnUse"><stop stop-color="#249361"/><stop offset="1" stop-color="#3ECF8E"/></linearGradient>' +
  '<linearGradient id="sbp_b" x1="36.1558" y1="30.578" x2="54.4844" y2="65.0806" gradientUnits="userSpaceOnUse"><stop/><stop offset="1" stop-opacity="0"/></linearGradient>' +
  "</defs></svg>";

export interface Brand {
  /** Deliverer name (logo alt / og); the report still analyses Supabase. */
  name: string;
  /** Bright accent: chart-bar fills, borders, badges. */
  accent: string;
  /** Readable accent: links, emphasis, sparkline strokes (contrast-safe). */
  ink: string;
  /** Inline SVG mark shown in the header. */
  logoSvg: string;
  /** Inline SVG used for the favicon data-uri (often the same mark). */
  faviconSvg: string;
}

export const DEFAULT_BRAND: Brand = {
  name: "Supabase",
  accent: "#3ECF8E",
  ink: "#006239",
  logoSvg: SUPABASE_LOGO_SVG,
  faviconSvg: SUPABASE_LOGO_SVG,
};

/** A brand file may override any subset; *Path fields are read into *Svg. */
const BrandFile = z
  .object({
    name: z.string(),
    accent: z.string(),
    ink: z.string(),
    logoSvg: z.string(),
    faviconSvg: z.string(),
    logoPath: z.string(),
    faviconPath: z.string(),
  })
  .partial()
  .strict();

export type BrandOverride = z.infer<typeof BrandFile>;

/** Merge a parsed + path-resolved override over the default brand. */
export function applyBrand(override: BrandOverride): Brand {
  const b: Brand = { ...DEFAULT_BRAND };
  if (override.name != null) b.name = override.name;
  if (override.accent != null) b.accent = override.accent;
  if (override.ink != null) b.ink = override.ink;
  if (override.logoSvg != null) b.logoSvg = override.logoSvg;
  if (override.faviconSvg != null) b.faviconSvg = override.faviconSvg;
  // A logo path with no explicit faviconSvg also becomes the favicon.
  if (override.faviconSvg == null && override.logoSvg != null) b.faviconSvg = override.logoSvg;
  return b;
}

/**
 * Resolve the active brand. Precedence: explicit file path (--brand /
 * SBPERF_BRAND) > ./sbperf.brand.json if present > the Supabase default.
 * `readFile` is injectable for tests.
 */
export async function loadBrand(
  opts: {
    file?: string;
    cwd?: string;
    env?: Record<string, string | undefined>;
    readText?: (path: string) => Promise<string>;
    exists?: (path: string) => Promise<boolean>;
  } = {},
): Promise<Brand> {
  const env = opts.env ?? process.env;
  const readText = opts.readText ?? ((p) => Bun.file(p).text());
  const exists = opts.exists ?? ((p) => Bun.file(p).exists());
  const cwd = opts.cwd ?? ".";

  let path = opts.file ?? env.SBPERF_BRAND;
  if (!path) {
    const local = `${cwd}/sbperf.brand.json`;
    if (await exists(local)) path = local;
  }
  if (!path) return { ...DEFAULT_BRAND };

  const raw = BrandFile.parse(JSON.parse(await readText(path)));
  const resolved: BrandOverride = { ...raw };
  if (raw.logoPath) resolved.logoSvg = await readText(raw.logoPath);
  if (raw.faviconPath) resolved.faviconSvg = await readText(raw.faviconPath);
  return applyBrand(resolved);
}

/** Favicon <link> as a self-contained data-uri. */
export function faviconTag(brand: Brand): string {
  return `<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(brand.faviconSvg)}">`;
}

/** CSS custom properties that carry the brand colours. */
export function brandVars(brand: Brand): string {
  return `--accent:${brand.accent};--link:${brand.ink}`;
}
