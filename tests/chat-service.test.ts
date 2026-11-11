import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Budget } from "../src/budget.ts";
import {
  ChatError, ChatService, chatSpend, clock, composeQuestion, foldChats, formatLine,
  type ChatCallRow, type ChatEvent, type ChatSource, type TranscriptLine,
} from "../src/chat/chat.ts";
import { CHAT_URL } from "../src/factcheck/s2.ts";
import { loadConfig } from "../src/config.ts";
import { cleanTmpDirs, tmpDir, withEnv } from "./fakes/env.ts";
import { FakeOpenRouter, replyChunks } from "./fakes/openrouter.ts";
import { json, sse, sseData, text } from "./fakes/responses.ts";

const cfg = loadConfig().app.chat;
const T0 = Date.parse("2026-09-30T10:00:00Z");
const line = (n: number, speakerId = "spk_1", speaker = "Speaker 1"): TranscriptLine =>
  ({ id: `u_${n}`, startMs: n * 10_000, speakerId, speaker, text: `line ${n}` });
const chunk = (o: Record<string, unknown>) => sseData({ id: "gen-1", model: "openai/gpt-6-luna", provider: "OpenAI", ...o });
const delta = (content: string) => chunk({ choices: [{ delta: { content } }] });

afterEach(() => {
  cleanTmpDirs();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A chat service on a tmp folder with a fake OpenRouter; `ask` runs a question and returns its events. */
function rig(lines: TranscriptLine[] = [line(1), line(2)], o: { budget?: Budget; live?: boolean; sleep?: boolean; extraModels?: string[]; modelChoice?: string } = {}) {
  const dir = tmpDir("chat-");
  const or = new FakeOpenRouter();
  const sleeps: number[] = [];
  let spends = 0;
  const source: ChatSource = { sessionId: "20260930-100000", dir, live: o.live ?? true, lines: () => lines, budget: o.budget };
  let current: ChatSource | null = source;
  const svc = new ChatService(cfg, {
    fetch: or.fetch, apiKey: "sk-or-test", source: () => current, onSpend: () => { spends++; }, rand: () => 0,
    ...(o.sleep === false ? {} : { sleep: async (ms: number) => { sleeps.push(ms); } }),
    ...(o.extraModels ? { extraModels: () => o.extraModels! } : {}),
    ...(o.modelChoice !== undefined ? { modelChoice: () => o.modelChoice } : {}),
  });
  const run = async (id: string, body: { content?: unknown; mode?: unknown }, onEvent?: (e: ChatEvent) => void) => {
    const events: ChatEvent[] = [];
    await svc.prepare(id, body)((e) => { events.push(e); onEvent?.(e); });
    return events;
  };
  const reply = (words = "Hello there", usage: Record<string, unknown> | null = { prompt_tokens: 120, completion_tokens: 8, cost: 0.0012 }) =>
    or.completions.push(() => sse(replyChunks(words, usage as Record<string, number> | null)));
  const rows = () => readFileSync(join(dir, "chats.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const done = (events: ChatEvent[]) => events.find((e) => e.type === "done") as Extract<ChatEvent, { type: "done" }>;
  return { dir, or, svc, sleeps, source, run, reply, rows, done, spends: () => spends, noSource: () => { current = null; } };
}

describe("clock, formatLine, composeQuestion", () => {
  it("clock: 0 → '0:00', 59_999 → '0:59', 3_725_000 → '1:02:05', negative → '0:00'", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(59_999)).toBe("0:59");
    expect(clock(600_000)).toBe("10:00");
    expect(clock(3_725_000)).toBe("1:02:05");
    expect(clock(-5000)).toBe("0:00");
    expect(formatLine(line(7, "spk_2", "Anna"))).toBe("[1:10] Anna: line 7");
  });

  it("clamps from when the lines shrink; upToMs stays null with no line ever", () => {
    const first = composeQuestion(undefined, [], true, "q1");
    expect(first.lines).toEqual({ from: 0, to: 0, upToMs: null, live: true, names: {} });
    const second = composeQuestion(first.lines, [], true, "q2");
    expect(second.lines.upToMs).toBeNull();
    expect(second.sent).toBe("<transcript_update>No new lines since the previous question.</transcript_update>\n\n<question>\nq2\n</question>");
    const shrunk = composeQuestion({ from: 0, to: 5, upToMs: 50_000, live: true, names: {} }, [line(1), line(2), line(3)], true, "q");
    expect(shrunk.lines).toMatchObject({ from: 3, to: 3, upToMs: 50_000 });
  });

  it("no rename note for a speaker absent from the current lines; no ended note from finished to finished, or live to live", () => {
    const prev = { from: 0, to: 1, upToMs: 10_000, live: false, names: { spk_9: "Gone", spk_1: "Speaker 1" } };
    const next = composeQuestion(prev, [line(1), line(2)], false, "q");
    expect(next.sent).not.toContain("<speaker_names>");
    expect(next.sent).not.toContain("recording_status");
    expect(next.lines.names).toEqual({ spk_9: "Gone", spk_1: "Speaker 1" });
    const live = composeQuestion({ ...prev, live: true }, [line(1)], true, "q");
    expect(live.sent).not.toContain("recording_status");
  });

  it("several renames are joined with '; ' and new speakers join the names", () => {
    const prev = composeQuestion(undefined, [line(1, "spk_1", "Speaker 1"), line(2, "spk_2", "Speaker 2")], true, "q").lines;
    const next = composeQuestion(prev, [line(1, "spk_1", "Nic"), line(2, "spk_2", "Anna"), line(3, "spk_3", "Speaker 3")], true, "q");
    expect(next.sent).toContain('<speaker_names>"Speaker 1" in earlier lines is now called "Nic"; "Speaker 2" in earlier lines is now called "Anna".</speaker_names>');
    expect(next.lines.names).toEqual({ spk_1: "Nic", spk_2: "Anna", spk_3: "Speaker 3" });
  });
});

describe("foldChats and chatSpend", () => {
  const at = (s: number) => new Date(T0 + s * 1000).toISOString();

  it("ignores rows for unknown chats; a rewind keeps messageRows so new ids stay unique; calls do not change updatedAt", () => {
    const call = { kind: "chat_call", chat_id: "chat_1", message_id: "m_2", cost_usd: 0.01, at: at(9) } as unknown as ChatCallRow;
    const chats = foldChats([
      { kind: "chat_message", chat_id: "ghost", id: "m_1", role: "user", content: "x", at: at(0) },
      { kind: "chat", op: "create", chat_id: "chat_1", title: "New chat", model: "m", at: at(1) },
      { kind: "chat_message", chat_id: "chat_1", id: "m_1", role: "user", content: "q", at: at(2) },
      { kind: "chat_message", chat_id: "chat_1", id: "m_2", role: "assistant", content: "a", at: at(3) },
      { kind: "chat", op: "rewind", chat_id: "chat_1", keep: 0, at: at(4) },
      call,
    ] as any);
    expect([...chats.keys()]).toEqual(["chat_1"]);
    const c = chats.get("chat_1")!;
    expect(c.messages).toEqual([]);
    expect(c.messageRows).toBe(2);
    expect(c.updatedAt).toBe(at(4));
    expect(c.calls).toEqual([call]);
  });

  it("chatSpend includes deleted chats and ignores a non-number cost_usd", () => {
    expect(chatSpend([
      { kind: "chat_call", chat_id: "chat_1", cost_usd: 0.25 }, { kind: "chat", op: "delete", chat_id: "chat_1", at: at(0) },
      { kind: "chat_call", chat_id: "chat_2", cost_usd: "0.5" }, { kind: "chat_call", chat_id: "chat_2", cost_usd: 0.5 },
      { kind: "chat_message", chat_id: "chat_2", cost_usd: 9 },
    ] as any)).toBe(0.75);
  });

  it("a torn last line in chats.jsonl is skipped", async () => {
    const r = rig();
    await r.svc.create();
    writeFileSync(join(r.dir, "chats.jsonl"), readFileSync(join(r.dir, "chats.jsonl"), "utf8") + '{"kind":"chat","op":"rena');
    expect(r.svc.list().chats.map((c) => c.id)).toEqual(["chat_1"]);
  });
});

describe("the model catalogue", () => {
  const offered = ["openai/gpt-6-luna", "openai/gpt-6-sol", "openai/gpt-6-astra"];
  const blank = (id: string) => ({ id, name: id, contextLength: null, maxOutput: null, inputUsdPerM: null, outputUsdPerM: null, cacheReadUsdPerM: null, available: null });

  it("models() does not fetch: repeated calls return the configured OpenAI ids", async () => {
    const { svc, or } = rig();
    const first = await svc.models();
    const again = await svc.models();
    expect(or.urls).toEqual([]);
    expect(again).toEqual(first);
    expect(first.default).toBe("openai/gpt-6-luna");
    expect(first.models).toEqual(offered.map(blank));
  });

  it("a throwing fetch is never called: availability stays null and the configured OpenAI ids are still returned", async () => {
    const f = vi.fn(async () => { throw new TypeError("fetch failed"); });
    const svc = new ChatService(cfg, { fetch: f as unknown as typeof fetch, apiKey: "k", source: () => null });
    const first = await svc.models();
    expect(f).not.toHaveBeenCalled();
    expect(first.models.every((m) => m.available === null && m.name === m.id && m.inputUsdPerM === null && m.contextLength === null)).toBe(true);
    expect(first.models.map((m) => m.id)).toEqual(offered);
    expect((await svc.models()).models).toEqual(first.models);
  });

  it("prices and context are always unknown; non-OpenAI configured ids are omitted; extraModels are offered", async () => {
    const { svc } = rig([], { extraModels: ["custom/gpt-extra", "bad id", "openai/gpt-6-luna"] });
    const m = (await svc.models()).models;
    expect(m.map((x) => x.id)).toEqual([...offered, "custom/gpt-extra"]);
    expect(m.every((x) => x.name === x.id && x.contextLength === null && x.maxOutput === null && x.inputUsdPerM === null && x.outputUsdPerM === null && x.cacheReadUsdPerM === null && x.available === null)).toBe(true);
  });

  it("a catalogue response is ignored: models() still lists the configured OpenAI ids, and the saved choice is the default when offered", async () => {
    const svc = new ChatService(cfg, { fetch: (async () => json({})) as unknown as typeof fetch, apiKey: "k", source: () => null, modelChoice: () => "openai/gpt-6-sol" });
    const m = await svc.models();
    expect(m.default).toBe("openai/gpt-6-sol");
    expect(m.models).toEqual(offered.map(blank));
    const missed = new ChatService(cfg, { fetch: (async () => json({ data: [] })) as unknown as typeof fetch, apiKey: "k", source: () => null, modelChoice: () => "anthropic/claude-sonnet-5" });
    expect((await missed.models()).default).toBe(cfg.defaultModel);
  });
});

describe("chats: create, update, remove", () => {
  it("with no session on screen, chat/create/update/remove/stop/prepare throw ChatError 409; list returns sessionId null", async () => {
    const r = rig();
    r.noSource();
    expect(r.svc.list()).toEqual({ sessionId: null, chats: [], spentUsd: 0 });
    const calls: (() => unknown)[] = [() => r.svc.chat("chat_1"), () => r.svc.create(), () => r.svc.update("chat_1", {}), () => r.svc.remove("chat_1"), () => r.svc.stop("chat_1"), () => r.svc.prepare("chat_1", { content: "q" })];
    for (const call of calls) {
      const e = await (async () => call())().catch((x) => x);
      expect(e).toBeInstanceOf(ChatError);
      expect(e).toMatchObject({ status: 409, message: "no session on screen: start one or open a recording to chat about it" });
    }
  });

  it("create with an allowed model; an unknown one → 400; ids count deleted chats (chat_2 after deleting chat_1)", async () => {
    const { svc } = rig();
    expect(await svc.create("openai/gpt-6-sol")).toMatchObject({ id: "chat_1", model: "openai/gpt-6-sol" });
    await expect(svc.create("anthropic/claude-sonnet-5")).rejects.toMatchObject({ status: 400, message: "unknown model anthropic/claude-sonnet-5" });
    await expect(svc.create("someone/else")).rejects.toMatchObject({ status: 400, message: "unknown model someone/else" });
    expect(svc.remove("chat_1")).toEqual({ deleted: "chat_1" });
    expect((await svc.create()).id).toBe("chat_2");
    await expect(svc.chat("chat_1")).rejects.toMatchObject({ status: 404, message: "unknown chat chat_1" });
    expect(() => svc.remove("chat_1")).toThrow("unknown chat chat_1");
    expect(svc.list().chats.map((c) => c.id)).toEqual(["chat_2"]);
  });

  it("update: title '' or 123 → 400; 121 characters → too long; a trimmed title is saved; the same model appends no row", async () => {
    const r = rig();
    await r.svc.create();
    for (const title of ["", "   ", 123]) await expect(r.svc.update("chat_1", { title })).rejects.toMatchObject({ status: 400, message: "title must be a non-empty string" });
    await expect(r.svc.update("chat_1", { title: "x".repeat(121) })).rejects.toMatchObject({ status: 400, message: "title is too long" });
    expect(await r.svc.update("chat_1", { title: `  ${"t".repeat(120)}  ` })).toMatchObject({ title: "t".repeat(120) });
    const before = r.rows().length;
    await r.svc.update("chat_1", { model: "openai/gpt-6-luna" });
    expect(r.rows()).toHaveLength(before);
    await expect(r.svc.update("chat_1", { model: 5 })).rejects.toMatchObject({ status: 400, message: "unknown model 5" });
    expect(await r.svc.update("chat_1", { model: "openai/gpt-6-sol", title: "Both" })).toMatchObject({ model: "openai/gpt-6-sol", title: "Both" });
    await expect(r.svc.update("chat_9", { title: "x" })).rejects.toMatchObject({ status: 404 });
  });

  it("list sorts by updatedAt (newest first) and reports busy while a reply streams", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const r = rig();
    vi.setSystemTime(T0);
    await r.svc.create();
    vi.setSystemTime(T0 + 1000);
    await r.svc.create();
    expect(r.svc.list().chats.map((c) => c.id)).toEqual(["chat_2", "chat_1"]);
    vi.setSystemTime(T0 + 2000);
    await r.svc.update("chat_1", { title: "Renamed" });
    expect(r.svc.list().chats.map((c) => c.id)).toEqual(["chat_1", "chat_2"]);
    let busy: unknown;
    r.or.completions.push((_b, init) => { busy = r.svc.list().chats.find((c) => c.id === "chat_2")!.busy; return sse(replyChunks("ok"), { signal: init.signal }); });
    await r.run("chat_2", { content: "q" });
    expect(busy).toBe(true);
    expect(r.svc.list().chats.find((c) => c.id === "chat_2")).toMatchObject({ busy: false, messages: 2, costUsd: 0.0012 });
  });
});

describe("asking: validation and what is sent", () => {
  it("prepare: busy → 409; empty content → 400; 20001 characters → 400; regenerate or edit with no question → 400; an unknown mode sends", async () => {
    const r = rig();
    await r.svc.create();
    for (const body of [{}, { content: "   " }, { content: 5 }]) expect(() => r.svc.prepare("chat_1", body)).toThrow("content is required");
    expect(() => r.svc.prepare("chat_1", { content: "x".repeat(20_001) })).toThrow("the question is too long");
    expect(() => r.svc.prepare("chat_1", { mode: "regenerate" })).toThrow("nothing to regenerate");
    expect(() => r.svc.prepare("chat_1", { mode: "edit", content: "q" })).toThrow("nothing to edit");
    expect(() => r.svc.prepare("chat_9", { content: "q" })).toThrow("unknown chat chat_9");
    const runner = r.svc.prepare("chat_1", { mode: "shout", content: "x".repeat(20_000) });
    let e: unknown;
    try { r.svc.prepare("chat_1", { content: "again" }); } catch (x) { e = x; }
    expect(e).toMatchObject({ status: 409, message: "this chat is already writing a reply" });
    r.reply();
    const events: ChatEvent[] = [];
    await runner((x) => events.push(x));
    expect(events[0]).toMatchObject({ type: "start", user: { role: "user" } }); // sent as a new question
    expect(() => r.svc.prepare("chat_1", { content: "free again" })).not.toThrow();
  });

  it("the start event's user has no 'sent'; a regenerate starts with user null and re-sends the question as it was", async () => {
    const r = rig();
    await r.svc.create();
    r.reply();
    const first = await r.run("chat_1", { content: "What happened?" });
    const start = first[0] as Extract<ChatEvent, { type: "start" }>;
    expect(start).toMatchObject({ type: "start", assistantId: "m_2", model: "openai/gpt-6-luna", user: { id: "m_1", content: "What happened?", role: "user" } });
    expect(start.user).not.toHaveProperty("sent");
    r.reply("Again");
    const regen = await r.run("chat_1", { mode: "regenerate" });
    expect(regen[0]).toEqual({ type: "start", user: null, assistantId: "m_3", model: "openai/gpt-6-luna" });
    expect(r.or.bodies[1].messages).toEqual(r.or.bodies[0].messages);
    expect(r.done(regen).chat).toMatchObject({ messages: [{ id: "m_1" }, { id: "m_3", content: "Again" }] });
    expect((r.done(regen).chat as any).messages[0]).not.toHaveProperty("sent");
  });

  it("auto-title comes only from the first question; over 60 characters gets '…'; a renamed chat is not auto-titled", async () => {
    const r = rig();
    await r.svc.create();
    await r.svc.create();
    const long = "What did   they say\nabout " + "pricing ".repeat(8);
    r.reply(); await r.run("chat_1", { content: long });
    r.reply(); await r.run("chat_1", { content: "second question" });
    const title = long.trim().replace(/\s+/g, " ").slice(0, 60) + "…";
    expect((await r.svc.chat("chat_1")).title).toBe(title);
    expect(r.rows().filter((x) => x.op === "rename")).toEqual([expect.objectContaining({ chat_id: "chat_1", title, auto: true })]);
    await r.svc.update("chat_2", { title: "Mine" });
    r.reply(); await r.run("chat_2", { content: "short" });
    expect((await r.svc.chat("chat_2")).title).toBe("Mine");
  });

  it.fails("BUG CH-L1: a question that only shrinks to 60 characters when its spaces collapse still gets '…'", async () => {
    const r = rig();
    await r.svc.create();
    const q = "a".repeat(30) + "    " + "b".repeat(29); // 63 characters; 60 once the spaces collapse: nothing is cut
    r.reply();
    await r.run("chat_1", { content: q });
    expect((await r.svc.chat("chat_1")).title).toBe("a".repeat(30) + " " + "b".repeat(29));
  });

  it("the request: bare model id, the whole history, stream with usage, reasoning_effort, Authorization and Content-Type only, and a stop signal joined to the timeout", async () => {
    const any = vi.spyOn(AbortSignal, "any");
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const r = rig();
    await r.svc.create();
    let init: RequestInit | undefined;
    r.or.completions.push((_b, i) => { init = i; return sse(replyChunks("ok")); });
    await r.run("chat_1", { content: "q" });
    const body = r.or.bodies[0];
    expect(body).toMatchObject({ model: "gpt-6-luna", stream: true, stream_options: { include_usage: true }, reasoning_effort: "low" });
    expect(body).not.toHaveProperty("provider");
    expect(body).not.toHaveProperty("reasoning");
    expect(body).not.toHaveProperty("usage");
    expect(body.messages.map((m: any) => m.role)).toEqual(["system", "user"]);
    expect(init!.headers).toEqual({ Authorization: "Bearer sk-or-test", "Content-Type": "application/json" });
    expect(timeout.mock.calls.map((c) => c[0])).toContain(cfg.timeoutMs);
    expect(any).toHaveBeenCalledOnce();
    expect(any.mock.calls[0]![0]).toHaveLength(2);
    expect(r.or.urls).toContain(CHAT_URL);
  });

  it("history leaves out failed replies with no content; an anthropic model marks the last message with cache_control", async () => {
    const r = rig([], { extraModels: ["anthropic/claude-sonnet-5"] });
    await r.svc.create("anthropic/claude-sonnet-5");
    r.or.completions.push(() => json({ error: { code: 401, message: "No auth" } }, 401));
    await r.run("chat_1", { content: "first" });
    r.reply();
    await r.run("chat_1", { content: "second" });
    const msgs = r.or.bodies[1].messages;
    expect(msgs.map((m: any) => m.role)).toEqual(["system", "user", "user"]);
    expect(msgs[2].content).toEqual([{ type: "text", text: expect.stringContaining("<question>\nsecond\n</question>"), cache_control: { type: "ephemeral" } }]);
    expect(typeof msgs[1].content).toBe("string");
  });

  it("a model change mid-chat sends the whole history to the new model", async () => {
    const r = rig();
    await r.svc.create();
    r.reply("Answer one");
    await r.run("chat_1", { content: "q1" });
    await r.svc.update("chat_1", { model: "openai/gpt-6-sol" });
    r.reply();
    await r.run("chat_1", { content: "q2" });
    const b = r.or.bodies[1];
    expect(b.model).toBe("gpt-6-sol");
    expect(b.messages.map((m: any) => [m.role, m.role === "assistant" ? m.content : undefined])).toEqual([["system", undefined], ["user", undefined], ["assistant", "Answer one"], ["user", undefined]]);
    expect(b.messages.slice(0, 3)).toEqual([...r.or.bodies[0].messages, { role: "assistant", content: "Answer one" }]);
  });

  it("chat rows never contain the API key: a key pasted into a question is written as [redacted]", async () => {
    const secret = "sk-or-v1-supersecret-0123456789";
    await withEnv({ OPENROUTER_API_KEY: secret }, async () => {
      const r = rig();
      await r.svc.create();
      r.reply();
      await r.run("chat_1", { content: `is ${secret} my key?` });
      const file = readFileSync(join(r.dir, "chats.jsonl"), "utf8");
      expect(file).not.toContain(secret);
      expect(file).toContain("is [redacted] my key?");
    });
  });
});

describe("the stream", () => {
  it("thinking is emitted once, before the first delta, for reasoning or reasoning_details", async () => {
    for (const d of [{ reasoning: "hmm" }, { reasoning_details: [{ type: "reasoning.text" }] }]) {
      const r = rig();
      await r.svc.create();
      r.or.completions.push(() => sse([chunk({ choices: [{ delta: d }] }), chunk({ choices: [{ delta: d }] }), delta("Hi"), chunk({ choices: [{ delta: { reasoning: "more" } }] }), chunk({ choices: [{ delta: {} }], usage: { cost: 0.001 } })]));
      const ev = await r.run("chat_1", { content: "q" });
      expect(ev.map((e) => e.type)).toEqual(["start", "thinking", "delta", "done"]);
    }
  });

  it("handles a line split across reads, CRLF, comment lines, bad JSON lines, empty data and [DONE]", async () => {
    const r = rig();
    await r.svc.create();
    const parts = [
      ": OPENROUTER PROCESSING\r\n\r\n",
      'data: {"id":"gen-7","model":"openai/gpt-6-luna","choices":[{"delta":{"con',
      'tent":"Hel"}}]}\r\n\r\n',
      "data: not json\n\n", "data:\n\n", "event: ping\n\n",
      'data: {"id":"gen-8","provider":"OpenAI","choices":[{"delta":{"content":"lo"}}],"usage":{"prompt_tokens":5,"completion_tokens":2,"cost":0.001}}\n\ndata: [DONE]\n\n',
    ];
    r.or.completions.push(() => sse(parts));
    const ev = await r.run("chat_1", { content: "q" });
    expect(ev.filter((e) => e.type === "delta").map((e: any) => e.text)).toEqual(["Hel", "lo"]);
    expect(r.done(ev).call).toMatchObject({ ok: true, id: "gen-7", model_returned: "openai/gpt-6-luna", provider_returned: "OpenAI", cost_usd: 0.001, usage: { prompt_tokens: 5, completion_tokens: 2, reasoning_tokens: 0, cached_tokens: 0 } });
    expect(r.done(ev).message).toMatchObject({ role: "assistant", content: "Hello" });
  });

  it("HTTP 429 before the stream is retried after the backoff sleep, then succeeds: attempts 2", async () => {
    const r = rig();
    await r.svc.create();
    r.or.completions.push(() => json({ error: { code: 429, message: "slow" } }, 429));
    r.reply();
    const ev = await r.run("chat_1", { content: "q" });
    expect(r.sleeps).toEqual([2000]);
    expect(r.done(ev).call).toMatchObject({ ok: true, attempts: 2 });
    expect(ev.some((e) => e.type === "error")).toBe(false);
  });

  it("a retry-after header sets the wait", async () => {
    const r = rig();
    await r.svc.create();
    r.or.completions.push(() => json({ error: { code: 503 } }, 503, { "retry-after": "4" }));
    r.reply();
    await r.run("chat_1", { content: "q" });
    expect(r.sleeps).toEqual([4000]);
  });

  it("a network error twice → an error event 'TypeError: fetch failed', then done with ok:false and attempts 2", async () => {
    const r = rig();
    await r.svc.create();
    r.or.completions.push(() => { throw new TypeError("fetch failed"); }, () => Promise.reject("reset"));
    const ev = await r.run("chat_1", { content: "q" });
    expect(ev.map((e) => e.type)).toEqual(["start", "error", "done"]);
    expect((ev[1] as any).message).toBe("reset");
    expect(r.done(ev).call).toMatchObject({ ok: false, attempts: 2, error: "reset", usage: null, cost_usd: 0 });
    const r2 = rig();
    await r2.svc.create();
    r2.or.completions.push(() => { throw new TypeError("fetch failed"); }, () => { throw new TypeError("fetch failed"); });
    const ev2 = await r2.run("chat_1", { content: "q" });
    expect((ev2[1] as any).message).toBe("TypeError: fetch failed");
    expect(r2.done(ev2).message).toMatchObject({ content: "", error: "TypeError: fetch failed" });
  });

  it("a mid-stream error chunk before any content is retried; after content it is not, and the partial reply is kept with the error", async () => {
    const r = rig();
    await r.svc.create();
    r.or.completions.push(() => sse([sseData({ error: { code: 502, message: "upstream" } })]));
    r.reply("Recovered");
    const ev = await r.run("chat_1", { content: "q" });
    expect(r.done(ev).call).toMatchObject({ ok: true, attempts: 2 });
    r.or.completions.push(() => sse([delta("Half"), sseData({ error: { code: 502, message: "upstream" } })]));
    const ev2 = await r.run("chat_1", { content: "q2" });
    expect(r.or.bodies).toHaveLength(3);
    expect(r.done(ev2).message).toMatchObject({ content: "Half", error: "openai/gpt-6-luna: upstream" });
    expect(r.done(ev2).call).toMatchObject({ ok: false, attempts: 1 });
  });

  it("an error chunk without a numeric code counts as a 2xx error body", async () => {
    const r = rig();
    await r.svc.create();
    r.or.completions.push(() => sse([sseData({ error: { message: "odd" } })]), () => sse([sseData({ error: { code: "E1", message: "odd" } })]));
    const ev = await r.run("chat_1", { content: "q" });
    expect(r.or.bodies).toHaveLength(2); // retried: no usable code
    expect((ev.find((e) => e.type === "error") as any).message).toBe("openai/gpt-6-luna: odd");
  });

  it("a stream that breaks while reading is a no-status error, retried", async () => {
    const r = rig();
    await r.svc.create();
    r.or.completions.push(() => sse([": x\n\n", "never"], { errorAfter: 1 }));
    r.reply();
    const ev = await r.run("chat_1", { content: "q" });
    expect(r.done(ev).call).toMatchObject({ ok: true, attempts: 2 });
  });

  it("401 → 'OpenAI rejected the API key (401)…', not retried", async () => {
    const r = rig();
    await r.svc.create();
    r.or.completions.push(() => json({ error: { code: 401, message: "No auth" } }, 401));
    const ev = await r.run("chat_1", { content: "q" });
    expect((ev.find((e) => e.type === "error") as any).message).toBe("OpenAI rejected the API key (401): check OPENAI_API_KEY.");
    expect(r.or.bodies).toHaveLength(1);
  });

  it("a non-transient 402 exhausts the session's budget ('provider'), says '(402)', and never throws out of the run", async () => {
    const exhausted: string[] = [];
    const budget = new Budget({ onExhausted: (e) => exhausted.push(`${e.cap}:${e.purpose}`) });
    const r = rig([line(1)], { budget });
    await r.svc.create();
    r.or.completions.push(() => json({ error: { code: 402, message: "Insufficient credits" } }, 402), () => json({ error: { code: 402 } }, 402));
    const ev = await r.run("chat_1", { content: "q" });
    expect((ev.find((e) => e.type === "error") as any).message).toBe("OpenAI credits or the key's limit are exhausted (402).");
    expect(exhausted).toEqual(["provider:chat"]);
    expect(budget.isExhausted).toBe(true);
    const again = await r.run("chat_1", { content: "q2" }); // already exhausted: exhaust throws inside, swallowed
    expect(again.at(-1)!.type).toBe("done");
    const noBudget = rig();
    await noBudget.svc.create();
    noBudget.or.completions.push(() => json({ error: { code: 402 } }, 402));
    expect((await noBudget.run("chat_1", { content: "q" })).at(-1)!.type).toBe("done");
  });

  it("a 404 with a message is '<model>: <msg>', including one that used to mean an OpenRouter data policy", async () => {
    const r = rig();
    await r.svc.create();
    r.or.completions.push(() => json({ error: { code: 404, message: "No endpoints found matching your data policy (Free model publication)" } }, 404));
    r.or.completions.push(() => json({ error: { code: 404, message: "Model not found" } }, 404));
    const a = await r.run("chat_1", { content: "q" });
    expect((a.find((e) => e.type === "error") as any).message).toBe("openai/gpt-6-luna: No endpoints found matching your data policy (Free model publication)");
    const b = await r.run("chat_1", { content: "q" });
    expect((b.find((e) => e.type === "error") as any).message).toBe("openai/gpt-6-luna: Model not found");
  });

  it("429 twice → the rate-limit message; another status with a non-JSON body → 'HTTP <s> …'", async () => {
    const r = rig();
    await r.svc.create();
    r.or.completions.push(() => json({ error: { code: 429 } }, 429), () => json({ error: { code: 429 } }, 429));
    const a = await r.run("chat_1", { content: "q" });
    expect((a.find((e) => e.type === "error") as any).message).toBe("openai/gpt-6-luna is rate-limited right now (429). Try again in a moment, or pick another model.");
    r.or.completions.push(() => text("Bad request, plain text", 400));
    const b = await r.run("chat_1", { content: "q" });
    expect((b.find((e) => e.type === "error") as any).message).toBe("HTTP 400 Bad request, plain text");
  });

  it("an ok response with no body is treated as a 2xx error without a code, and retried", async () => {
    const r = rig();
    await r.svc.create();
    r.or.completions.push(() => new Response(null, { status: 200 }));
    r.reply();
    const ev = await r.run("chat_1", { content: "q" });
    expect(r.done(ev).call).toMatchObject({ ok: true, attempts: 2 });
  });

  it("a timeout is an error, not a stop: retried, then reported", async () => {
    const r = rig();
    await r.svc.create();
    const timeout = () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); };
    r.or.completions.push(timeout, timeout);
    const ev = await r.run("chat_1", { content: "q" });
    expect(r.done(ev).call).toMatchObject({ ok: false, attempts: 2, error: "TimeoutError: The operation was aborted due to timeout" });
    expect(r.done(ev).call).not.toHaveProperty("stopped");
  });

  it("without an injected sleep, a retry waits on a real timer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const r = rig([line(1)], { sleep: false });
    await r.svc.create();
    r.or.completions.push(() => json({ error: { code: 503 } }, 503));
    r.reply();
    const p = r.run("chat_1", { content: "q" });
    await vi.advanceTimersByTimeAsync(1999);
    expect(r.or.bodies).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(r.or.bodies).toHaveLength(2);
  });
});

describe("stop, and the cost of a stopped reply", () => {
  const holdOpen = (r: ReturnType<typeof rig>, chunks: string[]) => r.or.completions.push((_b, init) => sse(chunks, { holdOpen: true, signal: init.signal }));

  it("stop mid-stream: {stopped:true}; the reply keeps its partial content; not retried; no generation lookup; cost 0 and estimated because prices are unknown", async () => {
    const budget = new Budget();
    const r = rig([line(1)], { budget });
    await r.svc.create();
    holdOpen(r, [delta("Partial")]);
    let stopped: unknown;
    const ev = await r.run("chat_1", { content: "q" }, (e) => { if (e.type === "delta") stopped = r.svc.stop("chat_1"); });
    const promptTok = Math.ceil(JSON.stringify(r.or.bodies[0]).length / 4);
    expect(stopped).toEqual({ stopped: true });
    expect(r.or.bodies).toHaveLength(1);
    expect(r.sleeps).toEqual([]);
    expect(r.or.urls.some((u) => u.includes("/generation"))).toBe(false);
    expect(r.done(ev).message).toMatchObject({ content: "Partial", stopped: true });
    expect(r.done(ev).call).toMatchObject({ ok: true, stopped: true, estimated: true, cost_usd: 0, usage: { prompt_tokens: promptTok, completion_tokens: Math.ceil("Partial".length / 4), reasoning_tokens: 0, cached_tokens: 0 } });
    expect(ev.some((e) => e.type === "error")).toBe(false);
    expect(budget.totals().chat).toBe(0);
    expect(r.spends()).toBe(0);
  });

  it("without a usage chunk, token counts are estimated from the request and the partial reply, not looked up", async () => {
    const r = rig();
    await r.svc.create();
    holdOpen(r, [delta("x")]);
    const ev = await r.run("chat_1", { content: "q" }, (e) => { if (e.type === "delta") r.svc.stop("chat_1"); });
    expect(r.or.urls.some((u) => u.includes("/generation"))).toBe(false);
    expect(r.done(ev).call.usage).toEqual({
      prompt_tokens: Math.ceil(JSON.stringify(r.or.bodies[0]).length / 4),
      completion_tokens: Math.ceil("x".length / 4),
      reasoning_tokens: 0,
      cached_tokens: 0,
    });
    expect(r.done(ev).call).toMatchObject({ estimated: true, cost_usd: 0 });
    expect(r.sleeps).toEqual([]);
  });

  it("missing usage.cost does not sleep or call /generation; cost is 0 and estimated", async () => {
    const r = rig();
    await r.svc.create();
    holdOpen(r, [delta("Hello")]);
    const ev = await r.run("chat_1", { content: "q" }, (e) => { if (e.type === "delta") r.svc.stop("chat_1"); });
    expect(r.sleeps).toEqual([]);
    expect(r.or.urls.some((u) => u.includes("/generation"))).toBe(false);
    const promptTok = Math.ceil(JSON.stringify(r.or.bodies[0]).length / 4);
    expect(r.done(ev).call).toMatchObject({ estimated: true, stopped: true, cost_usd: 0, usage: { prompt_tokens: promptTok, completion_tokens: Math.ceil("Hello".length / 4) } });
    expect((r.done(ev).chat as any).meter.estimated).toBe(true);
  });

  it("an estimate with no known prices costs 0", async () => {
    const r = rig();
    await r.svc.create();
    holdOpen(r, [delta("Hello")]);
    const ev = await r.run("chat_1", { content: "q" }, (e) => { if (e.type === "delta") r.svc.stop("chat_1"); });
    expect(r.done(ev).call).toMatchObject({ estimated: true, cost_usd: 0 });
    expect(r.spends()).toBe(0);
    expect(r.or.urls.some((u) => u.includes("/generation"))).toBe(false);
  });

  it("stopped before any chunk (no generation id): no generation lookup; cost 0 and estimated from the request", async () => {
    const budget = new Budget();
    const r = rig([line(1)], { budget });
    await r.svc.create();
    r.or.completions.push((_b, init) => { setTimeout(() => r.svc.stop("chat_1"), 0); return sse([], { holdOpen: true, signal: init.signal }); });
    const ev = await r.run("chat_1", { content: "q" });
    expect(r.done(ev).call).toMatchObject({
      stopped: true, estimated: true, cost_usd: 0, id: null,
      usage: { prompt_tokens: Math.ceil(JSON.stringify(r.or.bodies[0]).length / 4), completion_tokens: 0, reasoning_tokens: 0, cached_tokens: 0 },
    });
    expect(r.or.urls.some((u) => u.includes("/generation"))).toBe(false);
    expect(budget.totals().chat).toBe(0);
    expect(r.spends()).toBe(0);
  });

  it("stop() with nothing in flight → {stopped:false}", async () => {
    const r = rig();
    await r.svc.create();
    expect(r.svc.stop("chat_1")).toEqual({ stopped: false });
  });

  it("remove() aborts an in-flight reply: the reply and its cost are still saved, then the run ends with 'unknown chat'", async () => {
    const r = rig();
    await r.svc.create();
    r.or.completions.push((_b, init) => { setTimeout(() => r.svc.remove("chat_1"), 0); return sse([], { holdOpen: true, signal: init.signal }); });
    const events: ChatEvent[] = [];
    await expect(r.svc.prepare("chat_1", { content: "q" })((e) => events.push(e))).rejects.toMatchObject({ status: 404, message: "unknown chat chat_1" });
    expect(events.map((e) => e.type)).toEqual(["start"]);
    expect(r.rows().map((x) => x.kind === "chat" ? x.op : x.kind)).toEqual(["create", "chat_message", "rename", "delete", "chat_message", "chat_call"]);
    expect(r.rows().at(-1)).toMatchObject({ kind: "chat_call", stopped: true, estimated: true, cost_usd: 0 });
  });
});

describe("odd inputs", () => {
  it("an error response whose body cannot be read still reports its status", async () => {
    const r = rig();
    await r.svc.create();
    const broken = () => new Response(new ReadableStream({ start(c) { c.error(new TypeError("terminated")); } }), { status: 400 });
    r.or.completions.push(broken);
    const ev = await r.run("chat_1", { content: "q" });
    expect((ev.find((e) => e.type === "error") as any).message).toBe("HTTP 400");
  });

  it("a stream that fails with a non-Error reason is a no-status error named by that reason", async () => {
    const r = rig();
    await r.svc.create();
    const odd = () => new Response(new ReadableStream({ start(c) { c.error("socket gone"); } }), { status: 200 });
    r.or.completions.push(odd, odd);
    const ev = await r.run("chat_1", { content: "q" });
    expect(r.done(ev).call).toMatchObject({ ok: false, attempts: 2, error: "socket gone" });
  });

  it("a chunk without an id leaves the generation id to a later chunk; missing usage.cost is estimated, not looked up", async () => {
    const r = rig();
    await r.svc.create();
    r.or.completions.push((_b, init) => sse([sseData({ choices: [{ delta: { content: "A" } }] }), sseData({ id: "gen-9", choices: [{ delta: { content: "B" } }] })], { holdOpen: true, signal: init.signal }));
    let n = 0;
    const ev = await r.run("chat_1", { content: "q" }, (e) => { if (e.type === "delta" && ++n === 2) r.svc.stop("chat_1"); });
    expect(r.or.urls.some((u) => u.includes("/generation"))).toBe(false);
    expect(r.done(ev).call).toMatchObject({
      id: "gen-9", estimated: true, cost_usd: 0,
      usage: { prompt_tokens: Math.ceil(JSON.stringify(r.or.bodies[0]).length / 4), completion_tokens: Math.ceil("AB".length / 4) },
    });
  });

  it("an old question row without 'sent' is re-sent as its content; unknown row kinds and ops are ignored", async () => {
    const r = rig([line(1)]);
    await r.svc.create();
    const at = new Date().toISOString();
    const extra = [
      { kind: "chat_message", chat_id: "chat_1", id: "m_1", role: "user", content: "old question", at },
      { kind: "chat_message", chat_id: "chat_1", id: "m_2", role: "assistant", content: "old answer", at },
      { kind: "chat", op: "pin", chat_id: "chat_1", at },
      { kind: "note", chat_id: "chat_1", at },
    ];
    writeFileSync(join(r.dir, "chats.jsonl"), readFileSync(join(r.dir, "chats.jsonl"), "utf8") + extra.map((x) => JSON.stringify(x)).join("\n") + "\n");
    r.reply();
    await r.run("chat_1", { content: "new" });
    const msgs = r.or.bodies[0].messages;
    expect(msgs[1]).toEqual({ role: "user", content: "old question" });
    expect(msgs[2]).toEqual({ role: "assistant", content: "old answer" });
    expect(msgs[3].content).toContain('<transcript status="live, still being recorded" lines="1"'); // no earlier cursor: every line
    expect((await r.svc.chat("chat_1")).messages.map((m: any) => m.id)).toEqual(["m_1", "m_2", "m_3", "m_4"]);
  });
});

describe("the meter", () => {
  it("after an edit it uses the latest call still kept; totals count every call; pending lines and tokens", async () => {
    const lines = [line(1), line(2)];
    const r = rig(lines);
    await r.svc.create();
    r.reply("one", { prompt_tokens: 100, completion_tokens: 10, cost: 0.001, prompt_tokens_details: { cached_tokens: 60 }, completion_tokens_details: { reasoning_tokens: 4 } });
    await r.run("chat_1", { content: "q1" });
    r.reply("two", { prompt_tokens: 200, completion_tokens: 20, cost: 0.002 });
    await r.run("chat_1", { content: "q2" });
    r.or.completions.push(() => json({ error: { code: 401 } }, 401));
    const ev = await r.run("chat_1", { mode: "edit", content: "q2 edited" });
    const chat = r.done(ev).chat as any;
    expect(chat.messages.map((m: any) => m.content)).toEqual(["q1", "one", "q2 edited", ""]);
    expect(chat.meter).toMatchObject({
      model: "openai/gpt-6-luna", contextLength: null, contextTokens: 110, leftTokens: null,
      inputTokens: 300, cachedTokens: 60, outputTokens: 30, reasoningTokens: 4, costUsd: 0.003, estimated: false, pendingLines: 0, pendingTokens: 0,
    });
    lines.push(line(3), { ...line(4), text: "a longer line of text here" });
    const later = await r.svc.chat("chat_1") as any;
    const expected = [line(3), { ...line(4), text: "a longer line of text here" }].reduce((t, l) => t + Math.ceil(formatLine(l).length / 4) + 1, 0);
    expect(later.meter).toMatchObject({ pendingLines: 2, pendingTokens: expected });
    expect(r.rows().filter((x) => x.op === "rewind")).toEqual([expect.objectContaining({ keep: 2 })]);
  });

  it("leftTokens is null without a context length; the meter before any question is empty", async () => {
    const r = rig();
    r.or.models = [{ id: "openai/gpt-6-luna" }];
    const c = await r.svc.create() as any;
    expect(c.meter).toEqual({
      model: "openai/gpt-6-luna", contextLength: null, contextTokens: 0, leftTokens: null, inputTokens: 0, cachedTokens: 0,
      outputTokens: 0, reasoningTokens: 0, costUsd: 0, estimated: false, pendingLines: 2, pendingTokens: expect.any(Number),
    });
  });
});
