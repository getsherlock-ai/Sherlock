// Opt-in recovery checks against a real, explicitly selected LOCAL Redis.
// Every run uses an isolated BullMQ prefix and unique claim/lease keys.
// No production worker, GitHub adapter, Supabase client, or model is used.
import { randomUUID } from "node:crypto";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  buildDeliveryJobId,
  buildInvestigationJobId,
  createInvestigationQueueAdapter,
  WEBHOOK_COMMAND_CLAIM_PREFIX,
  type InvestigationJobPayload,
} from "../../backend/queue/investigation-queue.js";
import { recoverDurableWork } from "../../backend/services/durable-recovery.js";
import { createInMemoryProductDataStore } from "../../backend/services/product-data.js";
import {
  asScriptRunner,
  createInvestigationConcurrencyGate,
} from "../../backend/services/rate-limit.js";

const redisUrl = process.env.SHERLOCK_TEST_REDIS_URL;
if (redisUrl && !["127.0.0.1", "localhost", "[::1]"].includes(new URL(redisUrl).hostname)) {
  throw new Error("SHERLOCK_TEST_REDIS_URL must select a loopback Redis instance.");
}

describe.skipIf(!redisUrl)("local Redis recovery integration", () => {
  let redis: Redis;
  let queue: Queue;
  let prefix: string;
  let payload: InvestigationJobPayload;
  const workers: Worker[] = [];
  const keys = new Set<string>();
  const releaseBlocked: Array<() => void> = [];

  beforeEach(async () => {
    prefix = `sherlock-audit-${randomUUID()}`;
    redis = new Redis(redisUrl!, { lazyConnect: true, maxRetriesPerRequest: null, retryStrategy: () => null });
    redis.on("error", () => {});
    await redis.connect();
    queue = new Queue("recovery", { connection: redis, prefix });
    payload = {
      investigationId: `inv_LOCAL${Date.now().toString(32).toUpperCase()}`,
      tenantId: prefix, installationId: 1,
      repositoryOwner: "local-audit", repositoryName: "fixture",
      repositoryUrl: "https://github.com/local-audit/fixture", defaultBranch: "main",
      issueNumber: 1, issueTitle: "Local fixture", issueBody: "Local fixture only.",
      issueUrl: "https://github.com/local-audit/fixture/issues/1",
      triggeringCommentId: Date.now(), triggerComment: "/sherlock investigate", triggeredBy: "local-audit",
      sourceRef: null, deliveryId: null,
    };
    keys.add(`${WEBHOOK_COMMAND_CLAIM_PREFIX}${buildInvestigationJobId(payload)}`);
  });

  afterEach(async () => {
    for (const release of releaseBlocked.splice(0)) release();
    await Promise.all(workers.splice(0).map((worker) => worker.close(true)));
    if (queue) {
      // Only this test's randomly prefixed queue is removed, never FLUSHDB.
      await queue.obliterate({ force: true });
      await queue.close();
    }
    if (redis) {
      if (keys.size) await redis.del(...keys);
      keys.clear();
      await redis.quit();
    }
  });

  const waitFor = async (predicate: () => Promise<boolean>, timeoutMs = 8_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Local recovery condition did not complete before its deadline.");
  };

  const startWorker = (processor: ConstructorParameters<typeof Worker>[1]) => {
    const worker = new Worker(queue.name, processor, {
      connection: redis, prefix, lockDuration: 750, stalledInterval: 500,
    });
    // A deliberately abandoned processor may surface a missing-lock error.
    worker.on("error", () => {});
    workers.push(worker);
    return worker;
  };

  test("concurrent webhook redeliveries enqueue one job and consume one claim", async () => {
    const adapter = createInvestigationQueueAdapter(redis, queue);
    let claims = 0;
    const results = await Promise.all(Array.from({ length: 16 }, () => adapter.add(payload, {
      onClaim: async () => { claims += 1; return "allow" as const; },
    })));
    expect(results.filter((result) => !result.deduplicated)).toHaveLength(1);
    expect(claims).toBe(1);
    expect(await queue.getWaitingCount()).toBe(1);
  });

  test("an acknowledgement failure can retry without duplicating the retained job", async () => {
    const adapter = createInvestigationQueueAdapter(redis, queue);
    await expect(adapter.add(payload, {
      onEnqueued: async () => { throw new Error("simulated lost acknowledgement"); },
    })).rejects.toThrow("lost acknowledgement");
    expect(await redis.exists(`${WEBHOOK_COMMAND_CLAIM_PREFIX}${buildInvestigationJobId(payload)}`)).toBe(0);
    await expect(adapter.add(payload)).resolves.toMatchObject({ rateLimited: false });
    expect(await queue.getWaitingCount()).toBe(1);
  });

  test("durable recovery revives an exhausted retained delivery-only job", { timeout: 15_000 }, async () => {
    const delivery = {
      investigationId: payload.investigationId, tenantId: payload.tenantId,
      installationId: payload.installationId, repositoryOwner: payload.repositoryOwner,
      repositoryName: payload.repositoryName, issueNumber: payload.issueNumber,
    };
    const jobId = buildDeliveryJobId(delivery.investigationId);
    let attempts = 0;
    let delivered = 0;
    startWorker(async (job) => {
      expect(job.name).toBe("deliver");
      if (++attempts === 1) throw new Error("simulated temporary delivery failure");
      delivered += 1;
      return "delivered";
    });
    await queue.add("deliver", delivery, { jobId, attempts: 1, removeOnFail: false });
    await waitFor(async () => (await queue.getJob(jobId))?.getState().then((state) => state === "failed") ?? false);
    const productData = {
      ...createInMemoryProductDataStore(),
      listPendingDeliveryRecoveries: async () => [delivery],
    };
    const recovered = await recoverDurableWork({ productData, queue });
    expect(recovered).toMatchObject({ deliveryEnqueues: 1, failures: [] });
    await waitFor(async () => (await queue.getJob(jobId))?.getState().then((state) => state === "completed") ?? false);
    expect(attempts).toBe(2);
    expect(delivered).toBe(1);
  });

  test("a replacement worker recovers a job after the old worker stops renewing its lock", { timeout: 15_000 }, async () => {
    let started = false;
    const abandoned = startWorker(async () => {
      started = true;
      await new Promise<void>((resolve) => releaseBlocked.push(resolve));
      return "stale-owner";
    });
    const job = await queue.add("investigate", payload);
    await waitFor(async () => started);
    await abandoned.close(true);
    let recovered = 0;
    startWorker(async () => { recovered += 1; return "recovered"; });
    await waitFor(async () => (await queue.getJob(job.id!))?.getState().then((state) => state === "completed") ?? false);
    expect(recovered).toBe(1);
    expect((await queue.getJob(job.id!))?.returnvalue).toBe("recovered");
  });

  test("expired concurrency ownership cannot renew or release a replacement owner's lease", async () => {
    let now = Date.now();
    const gate = createInvestigationConcurrencyGate(() => asScriptRunner(redis), {
      config: { tenantLimit: 1, repoLimit: 1, slotTtlSeconds: 10 }, now: () => now, log: () => {},
    });
    const old = { tenantKey: prefix, repoKey: prefix, investigationId: payload.investigationId, leaseId: "old" };
    const replacement = { ...old, leaseId: "replacement" };
    // Known unique keys created by this test, not a database-wide scan/delete.
    keys.add(`sherlock:concurrency:tenant:${prefix}`);
    keys.add(`sherlock:concurrency:repo:${prefix}`);
    expect((await gate.acquireInvestigationConcurrency(old)).acquired).toBe(true);
    now += 11_000;
    expect((await gate.acquireInvestigationConcurrency(replacement)).acquired).toBe(true);
    expect(await gate.renewInvestigationConcurrency(old)).toBe(false);
    await gate.releaseInvestigationConcurrency(old);
    expect((await gate.acquireInvestigationConcurrency({ ...old, leaseId: "third" })).acquired).toBe(false);
    expect(await gate.renewInvestigationConcurrency(replacement)).toBe(true);
    await gate.releaseInvestigationConcurrency(replacement);
  });
});
