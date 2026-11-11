import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkKey, childEnv, credentialsPath, KEY_ENV, KEY_NAMES, KeyError, keyFormatProblem, KeySetup, KeyStore, loadKeys,
} from "../src/keys.ts";
import { cleanTmpDirs, tmpDir, withEnv } from "./fakes/env.ts";
import { fakeKeyCheckFetch } from "./fakes/keyCheck.ts";

const OPENAI = "sk-proj-abcdefghijklmnopqrstuvwxyz0123";
const OPENROUTER = "sk-or-v1-abcdefghijklmnopqrstuvwxyz9876";
const TYPESAFE = "ts-abcdefghijklmnopqrstuvwxyz9876";
/** A credentials path whose folder does not exist yet, as on a fresh Mac. Never the real one. */
const tmpCreds = () => join(tmpDir("keys-"), "Tattle", "credentials.json");

afterEach(() => {
  cleanTmpDirs();
  vi.restoreAllMocks();
});

describe("where the keys live", () => {
  it("credentialsPath uses TATTLE_CREDENTIALS, else Library/Application Support/Tattle/credentials.json (a string only)", () => {
    expect(credentialsPath({ TATTLE_CREDENTIALS: "/tmp/x/creds.json" })).toBe("/tmp/x/creds.json");
    expect(credentialsPath({ TATTLE_CREDENTIALS: "" })).toBe(join(homedir(), "Library", "Application Support", "Tattle", "credentials.json"));
    expect(credentialsPath({})).toMatch(/Library\/Application Support\/Tattle\/credentials\.json$/);
  });

  it("the KeyStore's default path comes from the given env's TATTLE_CREDENTIALS", () => {
    const p = tmpCreds();
    expect(new KeyStore({ env: { TATTLE_CREDENTIALS: p } }).path).toBe(p);
  });

  it("KEY_ENV and KEY_NAMES name the two keys; childEnv drops them, strips a leftover OpenRouter key, and keeps the rest", () => {
    expect(KEY_NAMES).toEqual(["openai", "typesafe"]);
    expect(KEY_ENV).toEqual({ openai: "OPENAI_API_KEY", typesafe: "TYPESAFE_API_KEY" });
    const env = { OPENAI_API_KEY: "a", TYPESAFE_API_KEY: "c", OPENROUTER_API_KEY: "b", PATH: "/bin" };
    expect(childEnv(env)).toEqual({ PATH: "/bin" });
    expect(env.OPENAI_API_KEY).toBe("a"); // a copy
  });
});

describe("KeyStore", () => {
  it("load treats a whitespace-only env var as unset and fills it from the file", () => {
    const path = tmpCreds();
    new KeyStore({ path, env: {} }).save({ openai: OPENAI });
    const env: NodeJS.ProcessEnv = { OPENAI_API_KEY: "   " };
    const store = new KeyStore({ path, env }).load();
    expect(env.OPENAI_API_KEY).toBe(OPENAI);
    expect(store.status()[0]).toMatchObject({ set: true, source: "file" });
  });

  it("status: the hint is the last 4 characters of the trimmed key; an unset key is set:false, source:null, hint:null", () => {
    const store = new KeyStore({ path: tmpCreds(), env: { OPENAI_API_KEY: `  ${OPENAI}\n` } }).load();
    expect(store.status()).toEqual([
      { name: "openai", env: "OPENAI_API_KEY", set: true, source: "environment", hint: "0123" },
      { name: "typesafe", env: "TYPESAFE_API_KEY", set: false, source: null, hint: null },
    ]);
    expect(store.missing()).toEqual(["typesafe"]);
  });

  it("save tightens an existing 0755 folder to 0700", () => {
    const path = tmpCreds();
    mkdirSync(dirname(path), { mode: 0o755 });
    chmodSync(dirname(path), 0o755);
    new KeyStore({ path, env: {} }).save({ typesafe: TYPESAFE });
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("save leaves no .tmp file behind, and writes 2-space JSON ending with a newline", () => {
    const path = tmpCreds();
    new KeyStore({ path, env: {} }).save({ openai: OPENAI, typesafe: TYPESAFE });
    expect(readdirSync(dirname(path))).toEqual(["credentials.json"]);
    expect(readFileSync(path, "utf8")).toBe(`{\n  "OPENAI_API_KEY": "${OPENAI}",\n  "TYPESAFE_API_KEY": "${TYPESAFE}"\n}\n`);
  });

  it("save refuses a key the environment sets (409), before writing anything", () => {
    const path = tmpCreds();
    const store = new KeyStore({ path, env: { TYPESAFE_API_KEY: TYPESAFE } }).load();
    let err: unknown;
    try { store.save({ openai: OPENAI, typesafe: TYPESAFE }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(KeyError);
    expect(err).toMatchObject({ status: 409, message: "TYPESAFE_API_KEY is set in .env or your shell, which wins over the page: change it there" });
    expect(existsSync(path)).toBe(false);
  });

  it("save of an empty key sets it empty in the environment and leaves it out of the file (documents behaviour)", () => {
    const path = tmpCreds();
    const env: NodeJS.ProcessEnv = {};
    new KeyStore({ path, env }).save({ openai: "" });
    expect(env.OPENAI_API_KEY).toBe("");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({});
  });

  it("read ignores non-string and blank values and trims the others", () => {
    const path = tmpCreds();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify({ OPENAI_API_KEY: 12345, TYPESAFE_API_KEY: `  ${TYPESAFE}  `, OTHER: "x" }), { mode: 0o600 });
    const env: NodeJS.ProcessEnv = {};
    new KeyStore({ path, env }).load();
    expect(env).toEqual({ TYPESAFE_API_KEY: TYPESAFE });
    writeFileSync(path, JSON.stringify({ OPENAI_API_KEY: "   " }), { mode: 0o600 });
    const env2: NodeJS.ProcessEnv = {};
    expect(new KeyStore({ path, env: env2 }).load().missing()).toEqual(["openai", "typesafe"]);
    writeFileSync(path, "null", { mode: 0o600 });
    expect(new KeyStore({ path, env: {} }).load().missing()).toEqual(["openai", "typesafe"]);
  });

  it("read reports a broken file with console.error, and the page asks for the keys again", () => {
    const path = tmpCreds();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, "{ broken", { mode: 0o600 });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(new KeyStore({ path, env: {} }).load().missing()).toEqual(["openai", "typesafe"]);
    expect(err).toHaveBeenCalledWith(`${path} is not valid JSON: ignored, so the page asks for the keys again`);
  });

  it("loadKeys fills process.env from the TATTLE_CREDENTIALS file", async () => {
    const path = tmpCreds();
    new KeyStore({ path, env: {} }).save({ openai: OPENAI, typesafe: TYPESAFE });
    await withEnv({ TATTLE_CREDENTIALS: path, OPENAI_API_KEY: undefined, TYPESAFE_API_KEY: undefined, OPENROUTER_API_KEY: "sk-or-leftover-should-stay-out" }, () => {
      const store = loadKeys();
      expect(store.path).toBe(path);
      expect(process.env.OPENAI_API_KEY).toBe(OPENAI);
      expect(process.env.TYPESAFE_API_KEY).toBe(TYPESAFE);
      expect(process.env.OPENROUTER_API_KEY).toBe("sk-or-leftover-should-stay-out"); // the file does not load a leftover OpenRouter key
    });
  });
});

describe("keyFormatProblem", () => {
  it("'' → Paste the key.; a tab or newline → no spaces; 19 and 401 chars → whole key; 20 and 400 pass", () => {
    expect(keyFormatProblem("openai", "")).toBe("Paste the key.");
    expect(keyFormatProblem("openai", "sk-abc\tdefghijklmnopqrstu")).toBe("A key has no spaces or line breaks: copy it again.");
    expect(keyFormatProblem("typesafe", `${TYPESAFE}\n`)).toBe("A key has no spaces or line breaks: copy it again.");
    expect(keyFormatProblem("openai", "k".repeat(19))).toBe("This does not look like a whole key: copy it again.");
    expect(keyFormatProblem("openai", "k".repeat(401))).toBe("This does not look like a whole key: copy it again.");
    expect(keyFormatProblem("openai", "k".repeat(20))).toBeNull();
    expect(keyFormatProblem("openai", "k".repeat(400))).toBeNull();
  });

  it("a leftover sk-or- key is refused in either field; an OpenAI key is named when pasted as TypeSafe", () => {
    const leftover = "OpenRouter keys are not used. Paste an OpenAI key in the OpenAI field, or a TypeSafe key in the TypeSafe field.";
    expect(keyFormatProblem("openai", OPENROUTER)).toBe(leftover);
    expect(keyFormatProblem("typesafe", OPENROUTER)).toBe(leftover);
    expect(keyFormatProblem("openai", "proj-abcdefghijklmnopqrstuvwxyz")).toBeNull();
    expect(keyFormatProblem("typesafe", TYPESAFE)).toBeNull();
    expect(keyFormatProblem("typesafe", OPENAI)).toBe("This looks like an OpenAI key: paste it in the OpenAI field.");
  });
});

describe("checkKey", () => {
  const respond = (status: number, body: string) => (async () => new Response(body, { status })) as unknown as typeof fetch;

  it("makes no fetch call when the format is wrong", async () => {
    const f = vi.fn();
    expect(await checkKey("openai", "short", { fetch: f as unknown as typeof fetch })).toEqual({ ok: false, message: "This does not look like a whole key: copy it again." });
    expect(f).not.toHaveBeenCalled();
  });

  it("asks the right URL with a Bearer header and a 10 s timeout", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const seen: { url: string; init: RequestInit }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ data: [] }));
    }) as unknown as typeof fetch;
    await checkKey("openai", OPENAI, { fetch: f });
    await checkKey("typesafe", TYPESAFE, { fetch: f });
    expect(seen.map((s) => s.url)).toEqual(["https://api.openai.com/v1/models", "https://api.typesafe.ai/v1/models"]);
    expect(seen.map((s) => (s.init.headers as Record<string, string>).Authorization)).toEqual([`Bearer ${OPENAI}`, `Bearer ${TYPESAFE}`]);
    expect(seen.every((s) => s.init.signal instanceof AbortSignal)).toBe(true);
    expect(timeout.mock.calls.map((c) => c[0])).toEqual([10_000, 10_000]);
  });

  it("401 refuses with a message for each service", async () => {
    expect(await checkKey("openai", OPENAI, { fetch: respond(401, "") })).toEqual({ ok: false, message: "OpenAI does not accept this key. Check it was copied whole, and not revoked." });
    expect(await checkKey("typesafe", TYPESAFE, { fetch: respond(401, "") })).toEqual({ ok: false, message: "TypeSafe does not accept this key. Check it was copied whole, and not revoked." });
  });

  it("403 and 500 are saved with an 'HTTP <s>' warning", async () => {
    for (const s of [403, 500]) {
      expect(await checkKey("openai", OPENAI, { fetch: respond(s, "nope") })).toEqual({
        ok: true, message: "Saved", warning: `The service answered HTTP ${s} when checking it. It was saved anyway.`,
      });
    }
  });

  it("a 200 with a non-JSON body says the key works, with no credit-limit warning", async () => {
    expect(await checkKey("typesafe", TYPESAFE, { fetch: respond(200, "<html>") })).toEqual({ ok: true, message: "Key works" });
    expect(await checkKey("openai", OPENAI, { fetch: respond(200, "<html>"), models: ["gpt-transcribe"] })).toEqual({ ok: true, message: "Key works" });
  });

  it("TypeSafe: a 200 from /v1/models is Key works; a leftover sk-or- key is refused before any fetch", async () => {
    expect(await checkKey("typesafe", TYPESAFE, { fetch: respond(200, JSON.stringify({ data: [{ id: "jev" }] })) })).toEqual({ ok: true, message: "Key works" });
    const f = vi.fn();
    expect(await checkKey("openai", OPENROUTER, { fetch: f as unknown as typeof fetch })).toEqual({
      ok: false,
      message: "OpenRouter keys are not used. Paste an OpenAI key in the OpenAI field, or a TypeSafe key in the TypeSafe field.",
    });
    expect(f).not.toHaveBeenCalled();
  });

  it("OpenAI: two lacking models are joined with ' and '; all present or an empty model list → no warning", async () => {
    const two = await checkKey("openai", OPENAI, { fetch: fakeKeyCheckFetch({ models: ["whisper"] }).f, models: ["gpt-transcribe", "gpt-live-transcribe"] });
    expect(two.warning).toBe("This key cannot use gpt-transcribe and gpt-live-transcribe, which transcription needs. Check the project's model permissions at platform.openai.com.");
    expect(await checkKey("openai", OPENAI, { fetch: fakeKeyCheckFetch().f, models: ["gpt-transcribe"] })).toEqual({ ok: true, message: "Key works" });
    expect(await checkKey("openai", OPENAI, { fetch: fakeKeyCheckFetch({ models: [] }).f, models: ["gpt-transcribe"] })).toEqual({ ok: true, message: "Key works" });
    expect(await checkKey("openai", OPENAI, { fetch: fakeKeyCheckFetch({ models: ["x"] }).f })).toEqual({ ok: true, message: "Key works" }); // no models asked for
  });
});

describe("KeySetup", () => {
  const setup = (env: NodeJS.ProcessEnv = {}, fetchFn = fakeKeyCheckFetch().f, extra: { required?: () => ("openai" | "typesafe")[] } = {}) => {
    const store = new KeyStore({ path: tmpCreds(), env }).load();
    return { store, env, setup: new KeySetup(store, { fetch: fetchFn, models: ["gpt-transcribe"], ...extra }) };
  };

  it("save: a null or string body → 400; a number value → 400 'openai must be a string'; nothing given → 400 'no key given'", async () => {
    const { setup: s } = setup();
    for (const body of [null, "str", 5]) await expect(s.save(body)).rejects.toMatchObject({ status: 400, message: "expected { openai?, typesafe? }" });
    await expect(s.save({ openai: 12 })).rejects.toMatchObject({ status: 400, message: "openai must be a string" });
    await expect(s.save({ typesafe: true })).rejects.toMatchObject({ status: 400, message: "typesafe must be a string" });
    for (const body of [{}, { openai: "" }, { openai: null, typesafe: undefined }]) {
      await expect(s.save(body)).rejects.toMatchObject({ status: 400, message: "no key given" });
    }
  });

  it("save: a key the environment sets → 409, and nothing is checked", async () => {
    const f = vi.fn();
    const { setup: s } = setup({ OPENAI_API_KEY: OPENAI }, f as unknown as typeof fetch);
    await expect(s.save({ openai: OPENAI })).rejects.toMatchObject({ status: 409, message: "OPENAI_API_KEY is set in .env or your shell, which wins over the page: change it there" });
    expect(f).not.toHaveBeenCalled();
  });

  it("save trims keys before checking and saving, and passes the transcription models only for OpenAI", async () => {
    const seen: string[] = [];
    const f = (async (url: string, init: RequestInit) => {
      seen.push(`${url} ${(init.headers as Record<string, string>).Authorization}`);
      return String(url).includes("openai")
        ? new Response(JSON.stringify({ data: [{ id: "whisper" }] }))
        : new Response(JSON.stringify({ data: [{ id: "jev" }] }));
    }) as unknown as typeof fetch;
    const { setup: s, store, env } = setup({}, f);
    const r = await s.save({ openai: `  ${OPENAI}\n`, typesafe: ` ${TYPESAFE} ` });
    expect(seen.sort()).toEqual([`https://api.openai.com/v1/models Bearer ${OPENAI}`, `https://api.typesafe.ai/v1/models Bearer ${TYPESAFE}`]);
    expect(r.checks.openai!.warning).toMatch(/cannot use gpt-transcribe/); // the models were passed for OpenAI
    expect(r.checks.typesafe).toEqual({ ok: true, message: "Key works" });
    expect(r.saved).toBe(true);
    expect(env).toMatchObject({ OPENAI_API_KEY: OPENAI, TYPESAFE_API_KEY: TYPESAFE });
    expect(JSON.parse(readFileSync(store.path, "utf8"))).toEqual({ OPENAI_API_KEY: OPENAI, TYPESAFE_API_KEY: TYPESAFE });
  });

  it("status: the path shows the home folder as ~; configured follows the required keys (OpenAI by default)", () => {
    const store = new KeyStore({ path: join(homedir(), "never-created-tattle-test", "credentials.json"), env: {} });
    expect(new KeySetup(store, { fetch: fakeKeyCheckFetch().f, models: [] }).status()).toMatchObject({
      configured: false, required: ["openai"], path: "~/never-created-tattle-test/credentials.json",
    });
    expect(new KeySetup(store, { fetch: fakeKeyCheckFetch().f, models: [], required: () => [] }).status()).toMatchObject({ configured: true, required: [] });
    const withTs = new KeyStore({ path: tmpCreds(), env: { TYPESAFE_API_KEY: TYPESAFE } }).load();
    expect(new KeySetup(withTs, { fetch: fakeKeyCheckFetch().f, models: [], required: () => ["typesafe"] }).status().configured).toBe(true);
    expect(new KeySetup(withTs, { fetch: fakeKeyCheckFetch().f, models: [] }).status().configured).toBe(false); // typesafe alone does not satisfy required ["openai"]
    expect(existsSync(join(homedir(), "never-created-tattle-test"))).toBe(false);
  });
});
