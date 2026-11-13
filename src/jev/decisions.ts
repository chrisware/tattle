// OpenAI's Decisions API as the other half of System 1 (docs/jev.md § Choosing the provider): the same typed questions
// as TypeSafe's Jev, on POST /v1/decisions with model gpt-6-luna. This module is the whole translation: question shape
// in, answers and a cost out, so the client and its retry/budget rules stay provider-agnostic.
import type { NoulQuestion, QuestionSet, JevAnswer, JevUsage, ScoreQuestion } from "./types.ts";

export const DEFAULT_DECISIONS_BASE = "https://api.openai.com/v1";

/** OpenAI's Decisions endpoint. `OPENAI_BASE_URL` moves it, like System 2's calls. */
export function decisionsUrl(base = process.env.OPENAI_BASE_URL ?? DEFAULT_DECISIONS_BASE): string {
  const b = base.trim().replace(/\/+$/, "").replace(/\/decisions$/, "");
  return `${b.endsWith("/v1") ? b : `${b}/v1`}/decisions`;
}

export interface DecisionPrices { inputUsdPerMToken: number; outputUsdPerMToken: number }

type InputPart =
  | { type: "input_text"; text: string }
  | { type: "input_json"; data: Record<string, unknown> | Record<string, unknown>[] };
export type DecisionInput = string | { role: "developer" | "user"; content: string | InputPart[] }[];

/**
 * The framing every request carries. Without it gpt-6-luna reads a predicate about a claim as "is this claim true"
 * and scores a false or unverifiable claim near zero, which is the opposite of what System 1 asks.
 */
export const FRAMING =
  "You are classifying a live podcast transcript. The input is JSON: current_segment is the recent context and new_utterance is the line to judge. Each question asks whether a property holds for new_utterance. Judge the property only, never whether the utterance is factually true: a false claim is still a claim, and an unverifiable one is still checkable.";

export type DecisionQuestion =
  | { type: "predicate"; name: string; instructions: string }
  | { type: "choice"; name: string; instructions: string; choices: { value: string; description?: string }[] }
  | { type: "score"; name: string; instructions: string; levels: { label: string }[] };

/** The `state` Jev reads as JSON becomes the Decisions input; anything that is not an object is sent as text. */
export function openaiInput(state: unknown): DecisionInput {
  if (state !== null && typeof state === "object" && !Array.isArray(state)) {
    return [
      { role: "developer", content: FRAMING },
      { role: "user", content: [{ type: "input_json", data: state as Record<string, unknown> }] },
    ];
  }
  return JSON.stringify(state ?? null);
}

/** A predicate has no criteria field, so yes/no wording the questions carry rides in the instructions. */
function predicateInstructions(q: NoulQuestion): string {
  if (!q.criteria) return q.instructions;
  return `${q.instructions}\nAnswer true only when: ${q.criteria.true} Answer false when: ${q.criteria.false}`;
}

/** The question id becomes the Decisions `name`, so answers come back keyed the way the app reads them. */
export function openaiQuestions(questions: QuestionSet): DecisionQuestion[] {
  return Object.entries(questions).map(([name, q]): DecisionQuestion => {
    if (q.type === "noul") return { type: "predicate", name, instructions: predicateInstructions(q) };
    if (q.type === "choice") {
      return {
        type: "choice", name, instructions: q.instructions,
        choices: Object.entries(q.criteria).map(([value, description]) => ({ value, description })),
      };
    }
    return { type: "score", name, instructions: q.instructions, levels: q.criteria.map((label) => ({ label })) };
  });
}

function probabilityPairs(raw: unknown, key: "value" | "label"): Record<string, number> {
  const out: Record<string, number> = {};
  if (!Array.isArray(raw)) return out;
  for (const p of raw) {
    if (p === null || typeof p !== "object") continue;
    const k = (p as Record<string, unknown>)[key];
    const v = (p as Record<string, unknown>).probability;
    if ((typeof k === "string" || typeof k === "number" || typeof k === "boolean") && typeof v === "number") out[String(k)] = v;
  }
  return out;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * The `answers` array back into the id-keyed map the app reads. A refusal is dropped for that one question, which every
 * consumer already treats as "no answer"; other questions in the same request still answer.
 */
export function openaiAnswers(raw: unknown, questions: QuestionSet): Record<string, JevAnswer> {
  const out: Record<string, JevAnswer> = {};
  const list = (raw as { answers?: unknown } | null)?.answers;
  if (!Array.isArray(list)) return out;
  for (const a of list) {
    if (a === null || typeof a !== "object") continue;
    const row = a as Record<string, unknown>;
    const name = typeof row.name === "string" ? row.name : null;
    if (!name || !(name in questions)) continue;
    if (row.type === "predicate" && typeof row.probability === "number") {
      out[name] = { type: "noul", noul: row.probability };
    } else if (row.type === "choice") {
      out[name] = {
        type: "choice", choice: String(row.choice), confidence: num(row.confidence),
        probabilities: probabilityPairs(row.probabilities, "value"),
      };
    } else if (row.type === "score") {
      const levels = (questions[name] as ScoreQuestion).criteria;
      out[name] = {
        type: "score", score: num(row.score), confidence: num(row.confidence),
        probabilities: probabilityPairs(row.probabilities, "label"),
        ...(levels.length ? { legend: Object.fromEntries(levels.map((label, i) => [String(i), label])) } : {}),
      };
    }
  }
  return out;
}

/** Token counts priced by the configured per-million rates; cached input is not separated here. */
export function openaiUsage(usage: unknown, prices: DecisionPrices): JevUsage {
  const u = usage as { input_tokens?: unknown; output_tokens?: unknown } | null | undefined;
  if (!u || typeof u.input_tokens !== "number") throw new Error("response without usage.input_tokens rejected");
  const input = u.input_tokens;
  const output = typeof u.output_tokens === "number" ? u.output_tokens : 0;
  return {
    input_tokens: input, output_tokens: output,
    cost: (input / 1e6) * prices.inputUsdPerMToken + (output / 1e6) * prices.outputUsdPerMToken,
  };
}

/** OpenAI reports an exhausted credit balance as a 429 with this code, not as a payment-required status. */
export function quotaExhausted(body: string): boolean {
  return body.includes("insufficient_quota");
}
