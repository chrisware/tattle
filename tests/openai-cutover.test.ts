import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KEY_NAMES, childEnv, keyFormatProblem } from "../src/keys.ts";
import { SettingsStore } from "../src/settings.ts";
import { cleanTmpDirs, tmpDir } from "./fakes/env.ts";

afterEach(() => cleanTmpDirs());

describe("OpenAI cutover", () => {
  it("keeps openai and typesafe only, and a leftover OpenRouter key never reaches a child", () => {
    expect(KEY_NAMES).toEqual(["openai", "typesafe"]);
    expect(childEnv({
      PATH: "/bin",
      OPENAI_API_KEY: "sk-openai-secret",
      TYPESAFE_API_KEY: "ts-secret",
      OPENROUTER_API_KEY: "sk-or-leftover-secret",
    })).toEqual({ PATH: "/bin" });
    const stale = "sk-or-" + "x".repeat(20);
    expect(keyFormatProblem("openai", stale)).toMatch(/OpenRouter keys are not used/);
    expect(keyFormatProblem("typesafe", stale)).toMatch(/OpenRouter keys are not used/);
  });

  it("deep-merges per-job model choices so one save does not wipe the others", () => {
    const store = new SettingsStore(join(tmpDir("cutover-"), "settings.json"));
    store.save({ models: { chat: "openai/gpt-6-luna" } } as never);
    expect(store.read()).toMatchObject({ models: { chat: "openai/gpt-6-luna" } });
    store.save({ models: { labels: "openai/gpt-6-sol" } } as never);
    expect(store.read()).toMatchObject({
      models: { chat: "openai/gpt-6-luna", labels: "openai/gpt-6-sol" },
    });
  });
});
