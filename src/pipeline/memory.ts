// Memory instrumentation for a session: one small row at the start, every 30 s, and at the end, so a profiling run can
// line process memory up with the session clock and the streams it was reading. The rows are tiny (a few hundred bytes
// every 30 s) and go to the session's memory.jsonl; nothing else changes when no one looks at them.

export interface MemoryRow {
  kind: "memory";
  at: string;
  /** Session time of the sample, from the same clock as every utterance. */
  sessionMs: number;
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
  /** The capture lanes this session read. */
  streams: string[];
}

interface Usage {
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
}

export class MemorySampler {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly write: (row: MemoryRow) => void,
    private readonly streams: string[],
    private readonly sessionMs: () => number = () => 0,
    private readonly intervalMs = 30_000,
    private readonly read: () => Usage = () => process.memoryUsage(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Samples now, then on every interval until stop(). */
  start(): void {
    if (this.timer) return;
    this.sample();
    this.timer = setInterval(() => this.sample(), this.intervalMs);
    this.timer.unref?.(); // a sampler never keeps the process alive
  }

  sample(): void {
    const m = this.read();
    this.write({
      kind: "memory", at: this.now().toISOString(), sessionMs: Math.round(this.sessionMs()),
      rss: m.rss, heapTotal: m.heapTotal, heapUsed: m.heapUsed, external: m.external, arrayBuffers: m.arrayBuffers,
      streams: [...this.streams],
    });
  }

  /** A last sample, then no more. Safe to call twice. */
  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
    this.sample();
  }
}
