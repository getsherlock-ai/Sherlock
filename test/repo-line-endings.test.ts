import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { cloneRepoForInvestigation, type GitRunner } from "../backend/services/repo.js";
import { validatePatchSafety, type FixProposal } from "../backend/services/fix-proposal.js";

const exec = promisify(execFile);
const roots: string[] = [];
const clones: string[] = [];
const source = [
  "  const filtered = q",
  "    ? recipes.filter(r => r.title.startsWith(q))",
  "    : recipes;",
  "",
  "  const start = page * PER_PAGE;",
  "",
].join("\n");
const proposal: FixProposal = {
  version: 1, summary: "Fix search and pagination", rootCause: "Prefix matching and page offset",
  confidence: 0.9, relevantTests: [], risk: "low", assumptions: [],
  files: [{ path: "server.js", edits: [{ oldText: source.trimEnd(), newText: source.trimEnd()
    .replace("r.title.startsWith(q)", "r.title.toLowerCase().includes(q.toLowerCase())")
    .replace("page * PER_PAGE", "(page - 1) * PER_PAGE") }] }],
};

afterEach(async () => {
  for (const clone of clones.splice(0)) {
    // These are temporary clones returned by the actual repository service.
    const root = path.dirname(path.resolve(clone));
    if (!path.basename(root).startsWith("handoff-")) throw new Error("Unexpected clone cleanup path");
    await rm(root, { recursive: true, force: true });
  }
  for (const root of roots.splice(0)) {
    if (!path.basename(path.resolve(root)).startsWith("sherlock-line-endings-")) throw new Error("Unexpected fixture cleanup path");
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture(attributes?: string) {
  const root = await mkdtemp(path.join(tmpdir(), "sherlock-line-endings-"));
  roots.push(root);
  const blankConfig = path.join(root, "blank.gitconfig");
  const hostConfig = path.join(root, "host.gitconfig");
  const hostText = "[core]\n\tautocrlf = true\n\teol = crlf\n";
  await writeFile(blankConfig, "");
  await writeFile(hostConfig, hostText);
  const baseEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: blankConfig, GIT_CONFIG_GLOBAL: blankConfig };
  const hostEnv = { ...baseEnv, GIT_CONFIG_GLOBAL: hostConfig };
  const src = path.join(root, "src");
  await mkdir(src);
  await exec("git", ["init", "--quiet", "-b", "main"], { cwd: src, env: baseEnv });
  await writeFile(path.join(src, "server.js"), source);
  if (attributes) await writeFile(path.join(src, ".gitattributes"), attributes);
  await exec("git", ["add", "."], { cwd: src, env: baseEnv });
  await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "--quiet", "-m", "seed"], { cwd: src, env: baseEnv });
  const bare = path.join(root, "bare.git");
  await exec("git", ["clone", "--quiet", "--bare", src, bare], { env: baseEnv });
  const runGit: GitRunner = async (args, options) => {
    const effective = args.includes("clone")
      ? args.map(arg => arg === "https://github.com/local-audit/fixture.git" ? bare : arg)
      : args;
    // Match production: clone gets its isolated child env; subsequent git
    // operations see the host config. Never modify this PC's Git settings.
    const { stdout } = await exec("git", effective, { cwd: options.cwd, env: { ...hostEnv, ...options.env } });
    return { stdout };
  };
  return { runGit, hostEnv, hostConfig, hostText };
}

test.each(["main", undefined])("rollback preserves the original exact edit with host autocrlf=true (branch %s)", async (branch) => {
  const f = await fixture();
  const context = await cloneRepoForInvestigation({ repoOwner: "local-audit", repoName: "fixture", defaultBranch: branch, runGit: f.runGit });
  clones.push(context.repoPath);
  const file = path.join(context.repoPath, "server.js");
  expect(await readFile(file, "utf8")).toBe(source);
  expect((await validatePatchSafety(proposal, context.repoPath)).ok).toBe(true);
  await writeFile(file, source.replace("startsWith(q)", "includes(q)"));
  await exec("git", ["checkout", "--", "."], { cwd: context.repoPath, env: f.hostEnv });
  expect(await readFile(file, "utf8")).toBe(source);
  expect((await validatePatchSafety(proposal, context.repoPath)).ok).toBe(true);
  expect(await readFile(f.hostConfig, "utf8")).toBe(f.hostText);
});

test("repository gitattributes still controls explicit CRLF checkouts", async () => {
  const f = await fixture("server.js text eol=crlf\n");
  const context = await cloneRepoForInvestigation({ repoOwner: "local-audit", repoName: "fixture", defaultBranch: "main", runGit: f.runGit });
  clones.push(context.repoPath);
  const file = path.join(context.repoPath, "server.js");
  const before = await readFile(file, "utf8");
  expect(before).toBe(source.replace(/\n/g, "\r\n"));
  await writeFile(file, "changed\n");
  await exec("git", ["checkout", "--", "."], { cwd: context.repoPath, env: f.hostEnv });
  expect(await readFile(file, "utf8")).toBe(before);
});
