import { afterEach, describe, expect, it, vi } from "vitest";
import { MemorySampler, type MemoryRow } from "../src/pipeline/memory.ts";

const usage = { rss: 100, heapTotal: 80, heapUsed: 60, external: 10, arrayBuffers: 5 };

afterEach(() => vi.useRealTimers());

describe("MemorySampler", () => {
  it("samples at the start, on every interval, and at stop, with the session clock and streams", () => {
    vi.useFakeTimers();
    const rows: MemoryRow[] = [];
    let ms = 0;
    const s = new MemorySampler((r) => rows.push(r), ["ch1", "ch2"], () => ms, 1000, () => usage, () => new Date("2026-01-01T00:00:00Z"));
    s.start();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "memory", sessionMs: 0, rss: 100, heapUsed: 60, streams: ["ch1", "ch2"], at: "2026-01-01T00:00:00.000Z" });
    ms = 1500;
    vi.advanceTimersByTime(1000);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.sessionMs).toBe(1500);
    s.stop();
    expect(rows).toHaveLength(3);
    vi.advanceTimersByTime(5000);
    expect(rows).toHaveLength(3); // stopped
    s.stop();
    expect(rows).toHaveLength(3); // safe twice
  });

  it("defaults to the session clock at zero, the real process memory, and 30 s rows", () => {
    vi.useFakeTimers();
    const rows: MemoryRow[] = [];
    const s = new MemorySampler((r) => rows.push(r), ["host"]);
    s.start();
    vi.advanceTimersByTime(30_000);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.sessionMs === 0 && r.rss > 0)).toBe(true);
    s.stop();
  });

  it("start twice keeps one timer", () => {
    vi.useFakeTimers();
    const rows: unknown[] = [];
    const s = new MemorySampler((r) => rows.push(r), [], () => 0, 1000, () => usage);
    s.start();
    s.start();
    vi.advanceTimersByTime(1000);
    expect(rows).toHaveLength(2); // the start, then one interval
    s.stop();
  });
});
