// Test preload: quiet the structured logger so per-plane/collect lines don't
// clutter test output. Must run before src/log.ts is imported (bunfig preload
// guarantees this). Real runs default to info.
process.env.SBPERF_LOG_LEVEL = "error";
// Disable the ASH-lite wait-event sampling loop (5x500ms) in tests - it would
// add ~2.5s to every collect() call. Production defaults to 5 samples; a
// dedicated test can re-enable it by setting SBPERF_WAIT_SAMPLES itself.
process.env.SBPERF_WAIT_SAMPLES = "0";
