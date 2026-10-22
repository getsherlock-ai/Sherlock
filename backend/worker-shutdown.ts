// Compose gives the worker 120 seconds. Reserve 20 seconds for the emergency
// Docker sweep and 10 seconds of margin. Normal draining remains unchanged.
export const WORKER_SHUTDOWN_DRAIN_MS = 90_000;

export function armWorkerShutdownDeadline(deps: {
  cleanup: () => void;
  exit?: (code: number) => void;
  log?: (message: string) => void;
}): () => void {
  const exit = deps.exit ?? ((code) => process.exit(code));
  const log = deps.log ?? ((message) => console.error(message));
  const timer = setTimeout(() => {
    try {
      log("Worker shutdown exceeded 90 seconds; force-removing owned sandboxes before exit. Active jobs will recover through lock and lease expiry.");
      deps.cleanup();
    } catch {
      log("Emergency sandbox cleanup failed; Docker may still have leftover target containers.");
    } finally {
      // Do not await anything or release active-job leases here. Exit before
      // interrupted pipeline callbacks can run; BullMQ stalled recovery and
      // existing fenced leases handle this exactly as a worker crash.
      exit(1);
    }
  }, WORKER_SHUTDOWN_DRAIN_MS);
  timer.unref();
  return () => clearTimeout(timer);
}
