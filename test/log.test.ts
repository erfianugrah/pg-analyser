import { describe, expect, test } from "bun:test";
import { makeLogger } from "../src/log.ts";

function capture(opts: Parameters<typeof makeLogger>[0] = {}) {
  const lines: string[] = [];
  const logger = makeLogger({ sink: (l) => lines.push(l), ...opts });
  return { logger, lines };
}

describe("logger", () => {
  test("respects the level floor", () => {
    const { logger, lines } = capture({ level: "warn" });
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("w");
    expect(lines[1]).toContain("e");
  });

  test("pretty format includes level tag + fields", () => {
    const { logger, lines } = capture({ level: "debug" });
    logger.info("hello", { ref: "abc", n: 3 });
    expect(lines[0]).toContain("INFO");
    expect(lines[0]).toContain("hello");
    expect(lines[0]).toContain("ref=abc");
    expect(lines[0]).toContain("n=3");
  });

  test("json mode emits one parseable object per line", () => {
    const { logger, lines } = capture({ level: "debug", json: true });
    logger.warn("boom", { source: "disk" });
    const obj = JSON.parse(lines[0]!);
    expect(obj.level).toBe("warn");
    expect(obj.msg).toBe("boom");
    expect(obj.source).toBe("disk");
    expect(typeof obj.time).toBe("string");
  });

  test("child binds fields onto every line", () => {
    const { logger, lines } = capture({ level: "debug", json: true });
    const child = logger.child({ ref: "xyz" });
    child.info("x");
    expect(JSON.parse(lines[0]!).ref).toBe("xyz");
  });

  test("time() emits durationMs from the injected clock and returns it", () => {
    let t = 1000;
    const { logger, lines } = capture({ level: "debug", json: true, now: () => t });
    const done = logger.time("plane", { source: "sql" });
    t = 1042;
    const ms = done({ ok: true });
    expect(ms).toBe(42);
    const obj = JSON.parse(lines[0]!);
    expect(obj.durationMs).toBe(42);
    expect(obj.source).toBe("sql");
    expect(obj.ok).toBe(true);
  });
});
