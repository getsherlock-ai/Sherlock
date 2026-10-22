import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { FixerAgentInput } from "../backend/agents/fixer.js";
import type { RepoContext } from "../backend/services/repo.js";

const mocks = vi.hoisted(() => ({ sandbox: vi.fn(), fixer: vi.fn(), analyze: vi.fn(), cleanup: vi.fn() }));
vi.mock("../backend/agents/fixer.js", () => ({ runFixerAgent: mocks.fixer }));
vi.mock("../backend/services/sandbox.js", async (original) => ({
  ...await original<typeof import("../backend/services/sandbox.js")>(), runSandboxInvestigation: mocks.sandbox,
}));
vi.mock("../backend/services/repo.js", async (original) => ({
  ...await original<typeof import("../backend/services/repo.js")>(), cleanupRepoContext: mocks.cleanup,
}));
vi.mock("../backend/services/graphContext.js", async (original) => ({
  ...await original<typeof import("../backend/services/graphContext.js")>(),
  buildGraphContext: async () => ({ available: false, graphNodes: "", graphEdges: "", relevantFiles: [], commitSha: "abc123", notes: "fixture" }),
}));
vi.mock("../backend/services/memory.js", async (original) => ({
  ...await original<typeof import("../backend/services/memory.js")>(),
  loadMemory: async () => [], appendMemory: async () => {}, hashRepoFilesAtCommit: async () => ({}),
}));
vi.mock("../backend/services/evidence-upload.js", () => ({ prepareReplayEvidence: async () => null }));
vi.mock("../backend/services/playwright.js", async (original) => ({
  ...await original<typeof import("../backend/services/playwright.js")>(),
  openLiveSession: async () => ({ readPageDigest: async () => "", close: async () => {} }),
  executeReproductionPlan: async () => ({
    outcome: "reproduced", outcomeReason: "Observed HTTP 500", steps: [],
    assertion: { matchedFailure: true, matchedExpected: false, observed: "500", detail: "Observed HTTP 500" },
    consoleErrors: [], pageErrors: [], networkFailures: [], apiResponses: [], screenshots: [], events: [],
    startedAt: "2026-10-21T00:00:00Z", finishedAt: "2026-10-21T00:00:01Z",
  }),
}));
vi.mock("../backend/services/claude.js", async (original) => ({
  ...await original<typeof import("../backend/services/claude.js")>(), analyzeIssue: mocks.analyze,
  generateReproductionPlan: async () => ({ rawText: "fixture", parseError: null, parsed: {
    version: 1, baseUrl: "http://localhost:3000", steps: [{ id: "step-1", action: "request", method: "GET", path: "/api/result" }],
    expectedBehavior: "HTTP 200", failureCondition: "HTTP 500",
    assertion: { type: "response_status", pathPattern: "/api/result", method: "GET", expected: 200, failureValue: 500 },
  } }),
  generateMemoryReflection: async () => ({ issueTerms: ["fixture"], rootCause: "fixture", whatWorked: "reproduction", whatFailed: "restart" }),
}));
import { runInvestigationPipeline } from "../backend/services/investigation.js";

let root: string | undefined;
afterEach(async () => {
  vi.unstubAllEnvs(); vi.clearAllMocks();
  if (root) {
    if (!path.basename(path.resolve(root)).startsWith("sherlock-restart-test-")) throw new Error("Unexpected cleanup path");
    await rm(root, { recursive: true, force: true }); root = undefined;
  }
});

test.each([true, false])("report preserves reproduction after a rejected patch (restart failed: %s)", async (restartFails) => {
  root = await mkdtemp(path.join(tmpdir(), "sherlock-restart-test-"));
  const repoPath = path.join(root, "repo"); await mkdir(repoPath);
  vi.stubEnv("ARTIFACTS_DIR", path.join(root, "artifacts"));
  vi.stubEnv("SHERLOCK_FORCE_REPRODUCER_AGENT", "false");
  const initial = { baseUrl: "http://localhost:3000", stdout: "original startup evidence", stderr: "" };
  const current = { ...initial, baseUrl: "http://localhost:3001", stdout: "restarted evidence" };
  const stop = vi.fn();
  mocks.sandbox.mockReset().mockResolvedValueOnce({ result: initial, stop });
  if (restartFails) mocks.sandbox.mockRejectedValueOnce(new Error("simulated install/startup failure"));
  else mocks.sandbox.mockResolvedValueOnce({ result: current, stop });
  mocks.analyze.mockResolvedValue({ summary: "The bug was reproduced; no fix verified." });
  mocks.fixer.mockImplementation(async (input: FixerAgentInput) => {
    const restarted = await input.restart();
    expect(restarted.ok).toBe(!restartFails);
    return { status: "exhausted", reason: "No fix verified", failureCode: "fixer_patch_failed_verification", attempts: [],
      fixAttempt: { fixAttemptId: "fix_FIXTURE", outcome: restartFails ? "rejected_build_failed" : "rejected_reproduction_still_fails",
        reason: "No fix verified", changedFiles: [], checks: [], testRuns: [], regressionTest: null, repositoryValidation: null,
        summary: "fixture", rootCause: "fixture", attemptDir: root },
    };
  });
  const terminal = vi.fn();
  const result = await runInvestigationPipeline({
    repoOwner: "local-audit", repoName: "fixture", repoUrl: "https://github.com/local-audit/fixture", defaultBranch: "main",
    issueNumber: 1, issueTitle: "Fixture failure",
  }, { cloneRepo: async () => ({ repoPath, commit: "abc123", fileTree: ["server.js"], sourceFiles: [], packageJson: null, readme: null }) as RepoContext,
    onTerminalResult: terminal });
  expect(result.outcome).toBe("reproduced");
  expect(result.fixAttempt?.outcome).toBe(restartFails ? "rejected_build_failed" : "rejected_reproduction_still_fails");
  expect(mocks.analyze.mock.calls[0][0].sandboxResult).toEqual(restartFails ? initial : current);
  expect(terminal).toHaveBeenCalledOnce();
  expect(terminal.mock.calls[0][0].outcome).toBe("reproduced");
  expect(mocks.cleanup).toHaveBeenCalledOnce();
});
