import { describe, expect, it } from "vitest";
import { Budget } from "../src/budget.ts";
import { loadConfig } from "../src/config.ts";
import { JevClient, type JevCallRow } from "../src/jev/client.ts";
import { decisionsUrl, FRAMING, openaiAnswers, openaiInput, openaiQuestions, openaiUsage } from "../src/jev/decisions.ts";
import type { QuestionSet } from "../src/jev/types.ts";

const cfg = loadConfig().app;
const DECISIONS = cfg.decisions.openai;
const QUESTIONS: QuestionSet = {
  claim: { type: "noul", instructions: "Is it a claim?", criteria: { true: "It states a fact.", false: "It is an opinion." } },
  claim_type: { type: "choice", instructions: "Which kind?", criteria: { number: "A figure.", none: "No claim." } },
  worth: { type: "score", instructions: "How much does it matter?", criteria: ["low", "mid", "high"] },
};

const OK = {
  answers: [
    { type: "predicate", name: "claim", probability: 0.91 },
    { type: "choice", name: "claim_type", choice: "number", confidence: 0.8, probabilities: [{ value: "number", probability: 0.8 }, { value: "none", probability: 0.2 }] },
    { type: "score", name: "worth", score: 2.4, confidence: 0.7, probabilities: [{ label: "low", value: 0, probability: 0.1 }, { label: "mid", value: 1, probability: 0.4 }, { label: "high", value: 2, probability: 0.5 }] },
  ],
  model: "gpt-6-luna-2026-09-22",
  usage: { input_tokens: 1_000_000, output_tokens: 1_000_000, total_tokens: 2_000_000 },
};

function setup(body: unknown = OK, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const rows: JevCallRow[] = [];
  const budget = new Budget();
  const client = new JevClient(cfg.jev, {
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch,
    apiKey: "ts-key", openaiKey: "sk-openai", provider: "openai", decisions: DECISIONS, budget, log: (r) => rows.push(r),
  });
  return { client, calls, rows, budget };
}

describe("OpenAI Decisions mapping", () => {
  it("maps each question type, with the id as the name", () => {
    expect(openaiQuestions(QUESTIONS)).toEqual([
      { type: "predicate", name: "claim", instructions: "Is it a claim?\nAnswer true only when: It states a fact. Answer false when: It is an opinion." },
      { type: "choice", name: "claim_type", instructions: "Which kind?", choices: [{ value: "number", description: "A figure." }, { value: "none", description: "No claim." }] },
      { type: "score", name: "worth", instructions: "How much does it matter?", levels: [{ label: "low" }, { label: "mid" }, { label: "high" }] },
    ]);
  });

  it("sends an object state as JSON input behind the framing, and anything else as text", () => {
    expect(openaiInput({ new_utterance: { text: "hi" } })).toEqual([
      { role: "developer", content: FRAMING },
      { role: "user", content: [{ type: "input_json", data: { new_utterance: { text: "hi" } } }] },
    ]);
    expect(FRAMING).toContain("never whether the utterance is factually true");
    expect(openaiInput("hi")).toBe('"hi"');
    expect(openaiInput([1, 2])).toBe("[1,2]");
    expect(openaiInput(null)).toBe("null");
  });

  it("keys answers by id, drops a refusal, and keeps the other answers", () => {
    const raw = {
      answers: [
        { type: "predicate", name: "claim", probability: 0.91 },
        { type: "refusal", name: "claim_type" },
        { type: "score", name: "worth", score: 2.4, confidence: 0.7, probabilities: [{ label: "low", value: 0, probability: 0.1 }, { label: "high", value: 2, probability: 0.5 }] },
        { type: "predicate", name: "not_asked", probability: 1 },
      ],
    };
    expect(openaiAnswers(raw, QUESTIONS)).toEqual({
      claim: { type: "noul", noul: 0.91 },
      worth: { type: "score", score: 2.4, confidence: 0.7, probabilities: { low: 0.1, high: 0.5 }, legend: { 0: "low", 1: "mid", 2: "high" } },
    });
  });

  it("tolerates what the API may omit or malform", () => {
    // a predicate with no criteria carries its instructions alone
    expect(openaiQuestions({ plain: { type: "noul", instructions: "Is it?" } })).toEqual([{ type: "predicate", name: "plain", instructions: "Is it?" }]);
    // no probabilities, non-array probabilities, and odd entries leave empty maps
    expect(openaiAnswers({ answers: [{ type: "choice", name: "claim_type", choice: "number", confidence: 0.5 }] }, QUESTIONS).claim_type)
      .toEqual({ type: "choice", choice: "number", confidence: 0.5, probabilities: {} });
    expect(openaiAnswers({ answers: [{ type: "choice", name: "claim_type", choice: "number", confidence: 0.5, probabilities: [null, { value: 1, probability: 0.4 }] }] }, QUESTIONS).claim_type)
      .toEqual({ type: "choice", choice: "number", confidence: 0.5, probabilities: { "1": 0.4 } });
    // a score whose question has no levels comes without a legend
    expect(openaiAnswers({ answers: [{ type: "score", name: "bare", score: 1, confidence: 0.5 }] }, { bare: { type: "score", instructions: "?", criteria: [] } }))
      .toEqual({ bare: { type: "score", score: 1, confidence: 0.5, probabilities: {} } });
    // an answers value that is not an array, and null entries, are ignored
    expect(openaiAnswers({ answers: "nope" }, QUESTIONS)).toEqual({});
    // an answer of a type Decisions does not define is ignored
    expect(openaiAnswers({ answers: [{ type: "mystery", name: "claim" }] }, QUESTIONS)).toEqual({});
    expect(openaiAnswers({ answers: [null, { type: "predicate", name: "claim", probability: 0.4 }] }, QUESTIONS)).toEqual({ claim: { type: "noul", noul: 0.4 } });
  });

  it("prices input and output tokens at the configured rates", () => {
    expect(openaiUsage({ input_tokens: 1e6, output_tokens: 1e6 }, DECISIONS)).toEqual({ input_tokens: 1e6, output_tokens: 1e6, cost: 0.6 });
    // output tokens absent: input is still priced
    expect(openaiUsage({ input_tokens: 1e6 }, DECISIONS)).toEqual({ input_tokens: 1e6, output_tokens: 0, cost: 0.1 });
    expect(() => openaiUsage({}, DECISIONS)).toThrow(/usage.input_tokens/);
  });

  it("builds the endpoint from the base, with or without /v1", () => {
    expect(decisionsUrl("https://api.openai.com/v1")).toBe("https://api.openai.com/v1/decisions");
    expect(decisionsUrl("https://gateway.test/")).toBe("https://gateway.test/v1/decisions");
    expect(decisionsUrl("https://api.openai.com/v1/decisions/")).toBe("https://api.openai.com/v1/decisions");
  });
});

describe("JevClient on the Decisions API", () => {
  it("posts the mapped request and returns id-keyed answers, cost, and a log row naming the provider", async () => {
    const { client, calls, rows, budget } = setup();
    const r = await client.ask({ new_utterance: { text: "Nvidia is worth five trillion." } }, QUESTIONS, { purpose: "utterance", utterance_id: "u_1" });
    expect(calls[0].url).toBe(decisionsUrl(DECISIONS.baseUrl));
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer sk-openai");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      model: DECISIONS.model, input: openaiInput({ new_utterance: { text: "Nvidia is worth five trillion." } }), questions: openaiQuestions(QUESTIONS),
    });
    expect(r.answers.claim).toEqual({ type: "noul", noul: 0.91 });
    expect(r.provider).toBe("OpenAI");
    expect(r.model).toBe("gpt-6-luna-2026-09-22");
    expect(r.usage.cost).toBeCloseTo(0.6);
    expect(rows[0]).toMatchObject({ kind: "jev_call", provider: "openai", ok: true, model_returned: "gpt-6-luna-2026-09-22", provider_returned: "OpenAI" });
    expect(budget.totals().jev).toBeCloseTo(0.6);
  });

  it("refuses to send without its Decisions config, and surfaces a network failure as no response", async () => {
    const rows: JevCallRow[] = [];
    const bare = new JevClient(cfg.jev, { fetch, apiKey: "", openaiKey: "k", provider: "openai", budget: new Budget(), log: (r) => rows.push(r) });
    await expect(bare.ask({}, QUESTIONS, { purpose: "utterance", maxAttempts: 1 })).rejects.toThrow("the OpenAI Decisions API is not configured");
    const bad = new JevClient(cfg.jev, {
      fetch: (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch,
      apiKey: "", openaiKey: "k", provider: "openai", decisions: DECISIONS, budget: new Budget(), log: (r) => rows.push(r),
    });
    await expect(bad.ask({}, QUESTIONS, { purpose: "utterance", maxAttempts: 1 })).rejects.toThrow("fetch failed");
    const noUsage = new JevClient(cfg.jev, {
      fetch: (async () => new Response(JSON.stringify({ answers: [] }), { status: 200 })) as unknown as typeof fetch,
      apiKey: "", openaiKey: "k", provider: "openai", decisions: DECISIONS, budget: new Budget(), log: (r) => rows.push(r),
    });
    await expect(noUsage.ask({}, QUESTIONS, { purpose: "utterance", maxAttempts: 1 })).rejects.toThrow("usage.input_tokens");
  });

  it("names the OpenAI key in a 401", async () => {
    const { client } = setup({ error: { message: "bad key", code: "invalid_api_key" } }, 401);
    await expect(client.ask({}, QUESTIONS, { purpose: "utterance" })).rejects.toThrow(/OpenAI rejected the API key \(401\): check OPENAI_API_KEY/);
  });

  it("treats insufficient_quota as the credit being used up, and does not retry it", async () => {
    const { client, calls } = setup({ error: { message: "You exceeded your current quota", code: "insufficient_quota" } }, 429);
    await expect(client.ask({}, QUESTIONS, { purpose: "relabel" })).rejects.toThrow(/insufficient_quota/);
    expect(calls.length).toBe(1);
  });
});
