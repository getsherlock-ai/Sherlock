import { afterEach, expect, test, vi } from "vitest";
import { armWorkerShutdownDeadline } from "../backend/worker-shutdown.js";

afterEach(() => vi.useRealTimers());

test("a stuck drain gets one cleanup attempt before Compose's 120 second limit", () => {
  vi.useFakeTimers();
  const order: string[] = [];
  armWorkerShutdownDeadline({
    cleanup: () => { order.push("cleanup"); },
    exit: (code) => { order.push(`exit:${code}`); },
    log: () => {},
  });
  vi.advanceTimersByTime(89_999);
  expect(order).toEqual([]);
  vi.advanceTimersByTime(1);
  expect(order).toEqual(["cleanup", "exit:1"]);
  vi.advanceTimersByTime(120_000);
  expect(order).toEqual(["cleanup", "exit:1"]);
});

test("a normally drained worker cancels emergency cleanup", () => {
  vi.useFakeTimers();
  const cleanup = vi.fn();
  const exit = vi.fn();
  const cancel = armWorkerShutdownDeadline({ cleanup, exit, log: () => {} });
  vi.advanceTimersByTime(1_000);
  cancel();
  vi.advanceTimersByTime(120_000);
  expect(cleanup).not.toHaveBeenCalled();
  expect(exit).not.toHaveBeenCalled();
});

test("a failed emergency cleanup still exits without exposing the raw error", () => {
  vi.useFakeTimers();
  const exit = vi.fn();
  const log = vi.fn();
  armWorkerShutdownDeadline({ cleanup: () => { throw new Error("private fixture data"); }, exit, log });
  vi.advanceTimersByTime(90_000);
  expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  expect(JSON.stringify(log.mock.calls)).not.toContain("private fixture data");
});

test("the deadline does not yield to a pipeline continuation triggered by removal", async () => {
  vi.useFakeTimers();
  const order: string[] = [];
  let unblock!: () => void;
  const continuation = new Promise<void>((resolve) => { unblock = resolve; })
    .then(() => { order.push("pipeline continuation"); });
  armWorkerShutdownDeadline({
    cleanup: () => { unblock(); order.push("cleanup"); },
    exit: () => { order.push("exit"); },
    log: () => {},
  });
  vi.advanceTimersByTime(90_000);
  expect(order).toEqual(["cleanup", "exit"]);
  // The real exit terminates here, before Node could resume the job and
  // mistake its interrupted sandbox for a terminal investigation failure.
  await continuation;
});
