// Test preload: quiet the structured logger so per-plane/collect lines don't
// clutter test output. Must run before src/log.ts is imported (bunfig preload
// guarantees this). Real runs default to info.
process.env.SBPERF_LOG_LEVEL = "error";
