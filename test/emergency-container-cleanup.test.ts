import { afterEach, expect, test, vi } from "vitest";
const { execFileSync } = vi.hoisted(() => ({ execFileSync: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(), execFileSync,
}));
import {
  cleanupAllContainers,
  cleanupAllContainersSync,
  trackContainer,
  type DockerAdapter,
} from "../backend/services/container.js";

const adapter = { removeContainer: async () => {} } as DockerAdapter;
afterEach(async () => { await cleanupAllContainers(); execFileSync.mockReset(); });

test("emergency cleanup removes only this process's tracked names in one bounded argv call", () => {
  trackContainer("sherlock-app-local-one", adapter);
  trackContainer("sherlock-test-local-two", adapter);
  expect(cleanupAllContainersSync()).toEqual(["sherlock-app-local-one", "sherlock-test-local-two"]);
  expect(execFileSync).toHaveBeenCalledExactlyOnceWith("docker", [
    "rm", "-f", "sherlock-app-local-one", "sherlock-test-local-two",
  ], { timeout: 20_000, killSignal: "SIGKILL", stdio: "ignore" });
  expect(cleanupAllContainersSync()).toEqual([]);
  expect(execFileSync).toHaveBeenCalledTimes(1);
});

test("failed emergency removal retains tracking for an honest retry", async () => {
  trackContainer("sherlock-app-local-retry", adapter);
  execFileSync.mockImplementationOnce(() => { throw new Error("daemon unavailable"); });
  expect(() => cleanupAllContainersSync()).toThrow("daemon unavailable");
  expect(await cleanupAllContainers()).toEqual(["sherlock-app-local-retry"]);
});

test("emergency cleanup never invokes Docker for an empty registry", () => {
  expect(cleanupAllContainersSync()).toEqual([]);
  expect(execFileSync).not.toHaveBeenCalled();
});
