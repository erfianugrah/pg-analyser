/**
 * Rename back-compat shim (sbperf -> pg-analyser, 2026-08-11).
 *
 * The canonical env prefix is PG_ANALYSER_. Any SBPERF_* variable whose
 * PG_ANALYSER_* counterpart is unset is copied over at process start, so old
 * shell rc files, pipeline definitions and muscle memory keep working. The
 * scan is prefix-based (not a fixed list) so per-ref SBPERF_DB_URL_<REF> and
 * any future vars are covered too.
 *
 * This module must be imported BEFORE anything that reads PG_ANALYSER_* env
 * vars (index.ts imports it first). Remove at the next major.
 */
for (const [key, value] of Object.entries(process.env)) {
  if (!key.startsWith("SBPERF_") || value === undefined) continue;
  const next = `PG_ANALYSER_${key.slice("SBPERF_".length)}`;
  if (process.env[next] === undefined) process.env[next] = value;
}
