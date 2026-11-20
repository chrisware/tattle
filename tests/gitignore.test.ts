import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// A worktree lacks the gitignored media folders and links them in from the
// main checkout (docs/gotchas.md § Testing). `fixtures/` and `models/` only
// match directories, so a symlink to them must have a rule of its own.
describe(".gitignore", () => {
  it("ignores the worktree's fixtures and models symlinks, and still re-includes tests/fixtures", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tattle-gitignore-"));
    dirs.push(root);
    await mkdir(path.join(root, "media"));
    await symlink(path.join(root, "media"), path.join(root, "fixtures"));
    await symlink(path.join(root, "media"), path.join(root, "models"));
    await mkdir(path.join(root, "tests", "fixtures"), { recursive: true });
    await writeFile(path.join(root, "tests", "fixtures", "keep.json"), "{}");
    await writeFile(path.join(root, ".gitignore"), await readFile(path.join(repoRoot, ".gitignore"), "utf8"));
    execFileSync("git", ["init", "-q"], { cwd: root });

    const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root, encoding: "utf8" });

    expect(status.trim().split("\n")).toEqual(["?? .gitignore", "?? tests/fixtures/keep.json"]);
  });
});
