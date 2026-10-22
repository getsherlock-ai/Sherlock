import { createServer, type Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createArtifactStore, createInvestigationId } from "../backend/services/artifacts.js";
import { executeReproductionPlan, openLiveSession } from "../backend/services/playwright.js";
import type { ReproductionPlan } from "../backend/services/plan.js";

describe("browser cleanup when page creation fails", () => {
  let server: Server;
  let baseUrl: string;
  beforeEach(async () => {
    server = createServer((_req, res) => res.end("local fixture"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  test.each([false, true])("replay closes the browser after page creation fails (recording=%s)", async (recordVideo) => {
    const failure = new Error("page creation failed");
    const close = vi.fn(async () => {});
    const newPage = vi.fn(async () => { throw failure; });
    vi.spyOn(chromium, "launch").mockResolvedValue({ close, newPage, newContext: async () => ({ newPage }) } as unknown as Browser);
    const store = await createArtifactStore(createInvestigationId(), await mkdtemp(path.join(tmpdir(), "sherlock-browser-cleanup-")));
    const plan: ReproductionPlan = {
      version: 1, baseUrl,
      steps: [{ id: "open", action: "goto", path: "/" }],
      expectedBehavior: "The page loads.", failureCondition: "The page is broken.",
      assertion: { type: "page_text", contains: "broken", failureWhen: "present" },
    };
    await expect(executeReproductionPlan(plan, store, { recordVideo })).rejects.toBe(failure);
    expect(close).toHaveBeenCalledOnce();
  });

  test("live exploration closes its browser after page creation fails", async () => {
    const failure = new Error("page creation failed");
    const close = vi.fn(async () => {});
    vi.spyOn(chromium, "launch").mockResolvedValue({ close, newPage: async () => { throw failure; } } as unknown as Browser);
    await expect(openLiveSession(baseUrl)).rejects.toBe(failure);
    expect(close).toHaveBeenCalledOnce();
  });

  test("a browser close error does not hide the original page creation error", async () => {
    const failure = new Error("page creation failed");
    const close = vi.fn(async () => { throw new Error("browser cleanup failed"); });
    vi.spyOn(chromium, "launch").mockResolvedValue({ close, newPage: async () => { throw failure; } } as unknown as Browser);
    await expect(openLiveSession(baseUrl)).rejects.toBe(failure);
    expect(close).toHaveBeenCalledOnce();
  });
});
