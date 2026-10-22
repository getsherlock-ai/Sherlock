import { describe, expect, test } from "vitest";
import {
  membershipAllows,
  isDashboardProjectionPending,
  reduceTimeline,
} from "../backend/services/product-read.js";
import type { SupabaseClient } from "@supabase/supabase-js";

describe("dashboard result publication", () => {
  const media = (["before", "after"] as const).flatMap((phase) =>
    (["video", "screenshot"] as const).map((kind) => ({ phase, kind, status: "ready" as const })));
  const complete = { status: "completed" as const, hasResult: true, media,
    delivery: { pr_status: "created", terminal_comment_status: "posted" } };

  test("finished execution keeps refreshing while its result or media is still being published", () => {
    expect(isDashboardProjectionPending({ ...complete, hasResult: false })).toBe(true);
    expect(isDashboardProjectionPending({ ...complete, media: media.slice(0, 2) })).toBe(true);
    expect(isDashboardProjectionPending({ ...complete, media: media.map((m) => ({ ...m, status: "pending" })) })).toBe(true);
    expect(isDashboardProjectionPending(complete)).toBe(false);
  });

  test("delivery must finish, and unavailable media or failed delivery are final states", () => {
    expect(isDashboardProjectionPending({ ...complete, delivery: null })).toBe(true);
    expect(isDashboardProjectionPending({ ...complete, delivery: { pr_status: "pending", terminal_comment_status: "posted" } })).toBe(true);
    expect(isDashboardProjectionPending({ ...complete, delivery: { pr_status: "created", terminal_comment_status: "pending" } })).toBe(true);
    expect(isDashboardProjectionPending({ ...complete, status: "failed",
      media: media.map((m) => ({ ...m, status: "unavailable" })),
      delivery: { pr_status: "blocked", terminal_comment_status: "failed" } })).toBe(false);
    expect(isDashboardProjectionPending({ status: "active", hasResult: false, media: [], delivery: null })).toBe(false);
  });
});

describe("dashboard timeline projection", () => {
  test("advances prior steps when a later stage becomes active", () => {
    const timeline = reduceTimeline(
      [
        {
          id: 1,
          stage_key: "open_preview",
          stage_status: "completed",
          message: "Repository preview opened.",
          occurred_at: "2026-07-23T00:00:01.000Z",
        },
        {
          id: 2,
          stage_key: "reproduce",
          stage_status: "active",
          message: "Reproducing the reported issue.",
          occurred_at: "2026-07-23T00:00:02.000Z",
        },
        {
          id: 3,
          stage_key: "diagnose",
          stage_status: "active",
          message: "Diagnosing the root cause.",
          occurred_at: "2026-07-23T00:00:03.000Z",
        },
      ],
      "active",
      false,
    );

    expect(timeline.map((step) => step.status)).toEqual([
      "completed",
      "completed",
      "active",
      "pending",
      "pending",
      "pending",
    ]);
    expect(timeline[2].message).toBe("Diagnosing the root cause.");
  });

  test("marks fix, verification, and PR stages skipped for a completed no-fix outcome", () => {
    const timeline = reduceTimeline(
      [
        {
          id: 1,
          stage_key: "reproduce",
          stage_status: "completed",
          message: "Reproduction completed.",
          occurred_at: "2026-07-23T00:00:02.000Z",
        },
        {
          id: 2,
          stage_key: "diagnose",
          stage_status: "completed",
          message: "Diagnosis completed.",
          occurred_at: "2026-07-23T00:00:03.000Z",
        },
      ],
      "completed",
      false,
    );

    expect(timeline.map((step) => step.status)).toEqual([
      "completed",
      "completed",
      "completed",
      "skipped",
      "skipped",
      "skipped",
    ]);
  });

  test("marks the active stage failed and all later stages skipped", () => {
    const timeline = reduceTimeline(
      [
        {
          id: 1,
          stage_key: "open_preview",
          stage_status: "completed",
          message: null,
          occurred_at: "2026-07-23T00:00:01.000Z",
        },
        {
          id: 2,
          stage_key: "reproduce",
          stage_status: "active",
          message: null,
          occurred_at: "2026-07-23T00:00:02.000Z",
        },
      ],
      "failed",
      false,
    );

    expect(timeline.map((step) => step.status)).toEqual([
      "completed",
      "failed",
      "skipped",
      "skipped",
      "skipped",
      "skipped",
    ]);
  });

  test("projects a setup failure even when no stage event was active", () => {
    const timeline = reduceTimeline([], "failed", false);

    expect(timeline.map((step) => step.status)).toEqual([
      "failed",
      "skipped",
      "skipped",
      "skipped",
      "skipped",
      "skipped",
    ]);
  });
});

describe("investigation repository authorization", () => {
  function client(repositoryStatus: "active" | "removed" | null) {
    const rows: Record<string, unknown> = {
      user_installations: { installation_id: "987" },
      github_installations: { status: "active" },
      installation_repositories:
        repositoryStatus === null ? null : { status: repositoryStatus },
    };
    return {
      from(table: string) {
        const builder = {
          select() {
            return builder;
          },
          eq() {
            return builder;
          },
          async maybeSingle() {
            return { data: rows[table] ?? null, error: null };
          },
        };
        return builder;
      },
    } as unknown as SupabaseClient;
  }

  test("requires an active repository for every new investigation row", async () => {
    await expect(
      membershipAllows(client("active"), "user-a", "987", "555"),
    ).resolves.toBe(true);
    await expect(
      membershipAllows(client("removed"), "user-a", "987", "555"),
    ).resolves.toBe(false);
    await expect(
      membershipAllows(client(null), "user-a", "987", "555"),
    ).resolves.toBe(false);
  });

  test("keeps legacy rows without repository ids installation-scoped", async () => {
    await expect(
      membershipAllows(client(null), "user-a", "987", null),
    ).resolves.toBe(true);
  });
});
