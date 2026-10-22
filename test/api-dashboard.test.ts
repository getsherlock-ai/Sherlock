import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ProductReadStore } from "../backend/services/product-read.js";
import {
  bootProductApi,
  createFakeAuthDeps,
  createInMemoryInstallationDataStore,
  createInMemoryProfileStore,
  makeGitHubUser,
  makeSnapshot,
  type BootedApp,
} from "./product-api-helpers.js";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const INV = "inv_01K123456789AB";

function investigationView() {
  return {
    id: INV,
    issueTitle: "Broken dashboard",
    status: "active" as const,
    error: null,
    updatedAt: "2026-07-23T00:00:00.000Z",
    version: 4,
    timeline: [
      {
        id: "open_preview" as const,
        label: "Open repository preview",
        status: "completed" as const,
        message: "Repository preview opened.",
        startedAt: "2026-07-23T00:00:00.000Z",
        finishedAt: "2026-07-23T00:00:01.000Z",
      },
    ],
    evidence: {
      before: { replay: { status: "pending" as const }, screenshots: [] },
      after: { replay: { status: "pending" as const }, screenshots: [] },
    },
    fix: null,
    pullRequest: null,
  };
}

describe("dashboard product API", () => {
  let booted: BootedApp;
  let store: ReturnType<typeof createInMemoryInstallationDataStore>;
  let productRead: ProductReadStore;
  const listIssues = vi.fn();
  const fetchInstallation = vi.fn();
  const fetchInstallationRepositories = vi.fn();

  beforeEach(async () => {
    fetchInstallation.mockReset().mockResolvedValue(makeSnapshot());
    fetchInstallationRepositories.mockReset().mockResolvedValue([]);
    store = createInMemoryInstallationDataStore();
    const profiles = createInMemoryProfileStore();
    await store.upsertInstallationSnapshot(makeSnapshot(), {
      eventAt: "2026-07-23T00:00:00.000Z",
    });
    await store.upsertMembership({
      userId: USER_A,
      installationId: "987654321",
      relationship: "installer",
      verificationMethod: "installation_webhook_sender",
    });
    await store.upsertInstallationRepositories(
      "987654321",
      [
        {
          repositoryId: "555",
          ownerLogin: "SherlockHQ",
          name: "sherlock",
          fullName: "SherlockHQ/sherlock",
          private: true,
        },
      ],
      "2026-07-23T00:00:00.000Z",
    );

    productRead = {
      findIssueInvestigation: async (input) =>
        input.userId === USER_A &&
        input.repositoryId === "555" &&
        input.issueNumber === 7
          ? {
              investigationId: INV,
              status: "active",
              statusUrl: `/investigations/${INV}`,
            }
          : null,
      getInvestigation: async (userId, investigationId) =>
        userId === USER_A && investigationId === INV
          ? investigationView()
          : null,
      getInvestigationDiff: async (userId, investigationId) =>
        userId === USER_A && investigationId === INV
          ? { diff: "diff --git a/a.ts b/a.ts\n", diffTruncated: false }
          : null,
    };
    listIssues.mockReset();
    listIssues.mockResolvedValue({
      issues: [
        {
          id: "700",
          number: 7,
          title: "Broken dashboard",
          body: "The page fails.",
          state: "open",
          htmlUrl: "https://github.com/SherlockHQ/sherlock/issues/7",
          author: { login: "octo", avatarUrl: null },
          labels: ["bug"],
          createdAt: "2026-07-22T00:00:00.000Z",
          updatedAt: "2026-07-23T00:00:00.000Z",
        },
      ],
      hasNextPage: false,
    });

    booted = await bootProductApi(
      { NODE_ENV: "test" },
      {
        getAuthDeps: async () =>
          createFakeAuthDeps(
            {
              "token-a": makeGitHubUser({ id: USER_A }),
              "token-b": makeGitHubUser({
                id: USER_B,
                githubUserId: "987",
                login: "other",
              }),
            },
            profiles,
          ),
        getInstallationStore: async () => store,
        getProductReadStore: async () => productRead,
        listGitHubIssues: listIssues,
        fetchInstallation,
        fetchInstallationRepositories,
      },
    );
  });

  afterEach(async () => {
    await booted.close();
  });

  test("refresh reconciles saved GitHub additions and removals for existing memberships", async () => {
    const repos = [555, 556, 557].map((id) => ({ repositoryId: String(id), ownerLogin: "SherlockHQ",
      name: `repo-${id}`, fullName: `SherlockHQ/repo-${id}`, private: true }));
    fetchInstallationRepositories.mockResolvedValue(repos);
    const refresh = () => fetch(`${booted.baseUrl}/api/installations/refresh`, {
      method: "POST", headers: { Authorization: "Bearer token-a", "Content-Type": "application/json" }, body: "{}",
    });
    expect((await refresh()).status).toBe(200);
    expect((await store.listRepositoriesForUser(USER_A)).map((r) => r.repositoryId)).toEqual(["555", "556", "557"]);
    fetchInstallationRepositories.mockResolvedValue([repos[2]]);
    expect((await refresh()).status).toBe(200);
    expect((await store.listRepositoriesForUser(USER_A)).map((r) => r.repositoryId)).toEqual(["557"]);
    expect(await store.listRepositoriesForUser(USER_B)).toEqual([]);
    expect(fetchInstallationRepositories).toHaveBeenCalledWith("987654321");
  });

  test("refresh rejects caller-supplied IDs and never discovers another user's installations", async () => {
    const url = `${booted.baseUrl}/api/installations/refresh`;
    const post = (token: string, body = "{}") => fetch(url, { method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body });
    expect((await post("invalid")).status).toBe(401);
    expect((await post("token-a", '{"installationId":"123"}')).status).toBe(400);
    expect((await post("token-b")).status).toBe(200);
    expect(fetchInstallation).not.toHaveBeenCalled();
    expect(fetchInstallationRepositories).not.toHaveBeenCalled();
    expect(await store.listInstallationsForUser(USER_B)).toEqual([]);
  });

  test("failed repository reads preserve the snapshot, while suspension hides access", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      fetchInstallationRepositories.mockRejectedValue(new Error("GitHub unavailable"));
      const post = () => fetch(`${booted.baseUrl}/api/installations/refresh`, { method: "POST",
        headers: { Authorization: "Bearer token-a", "Content-Type": "application/json" }, body: "{}" });
      expect((await post()).status).toBe(500);
      expect((await store.listRepositoriesForUser(USER_A)).map((r) => r.repositoryId)).toEqual(["555"]);
      fetchInstallation.mockResolvedValue(makeSnapshot({ suspendedAt: "2026-10-22T00:00:00.000Z" }));
      expect((await post()).status).toBe(200);
      expect(await store.listRepositoriesForUser(USER_A)).toEqual([]);
      expect(fetchInstallationRepositories).toHaveBeenCalledTimes(1);
    } finally { log.mockRestore(); }
  });

  test("lists only repositories authorized through installation membership", async () => {
    const allowed = await fetch(`${booted.baseUrl}/api/repositories`, {
      headers: { Authorization: "Bearer token-a" },
    });
    expect(allowed.status).toBe(200);
    await expect(allowed.json()).resolves.toEqual({
      repositories: [
        {
          id: "555",
          fullName: "SherlockHQ/sherlock",
          htmlUrl: "https://github.com/SherlockHQ/sherlock",
          private: true,
          ownerAvatarUrl: "https://avatars.githubusercontent.com/u/123456789",
          installationId: "987654321",
        },
      ],
    });

    const denied = await fetch(`${booted.baseUrl}/api/repositories`, {
      headers: { Authorization: "Bearer token-b" },
    });
    await expect(denied.json()).resolves.toEqual({ repositories: [] });
  });

  test("lists GitHub issues only after repository authorization", async () => {
    const response = await fetch(
      `${booted.baseUrl}/api/repositories/555/issues?state=all&page=2&perPage=30`,
      { headers: { Authorization: "Bearer token-a" } },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      issues: Array<{ id: string; number: number }>;
      pagination: { page: number; hasNextPage: boolean };
    };
    expect(body.issues).toEqual([{ id: "700", number: 7 }].map((partial) =>
      expect.objectContaining(partial),
    ));
    expect(body.pagination).toMatchObject({ page: 2, hasNextPage: false });
    expect(listIssues).toHaveBeenCalledWith(
      expect.objectContaining({
        installationId: "987654321",
        owner: "SherlockHQ",
        repository: "sherlock",
        state: "all",
        page: 2,
      }),
    );

    const denied = await fetch(
      `${booted.baseUrl}/api/repositories/555/issues`,
      { headers: { Authorization: "Bearer token-b" } },
    );
    expect(denied.status).toBe(404);
    expect(listIssues).toHaveBeenCalledTimes(1);
  });

  test("looks up the latest investigation for an authorized issue", async () => {
    const response = await fetch(
      `${booted.baseUrl}/api/repositories/555/issues/7/investigation`,
      { headers: { Authorization: "Bearer token-a" } },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      investigationId: INV,
      status: "active",
      statusUrl: `/investigations/${INV}`,
    });
  });

  test("returns a private ETag and hides cross-user investigations as 404", async () => {
    const response = await fetch(
      `${booted.baseUrl}/api/investigations/${INV}`,
      { headers: { Authorization: "Bearer token-a" } },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-cache");
    const etag = response.headers.get("etag");
    expect(etag).toBe(`W/"investigation-${INV}-4"`);

    const unchanged = await fetch(
      `${booted.baseUrl}/api/investigations/${INV}`,
      {
        headers: {
          Authorization: "Bearer token-a",
          "If-None-Match": etag as string,
        },
      },
    );
    expect(unchanged.status).toBe(304);

    const denied = await fetch(
      `${booted.baseUrl}/api/investigations/${INV}`,
      { headers: { Authorization: "Bearer token-b" } },
    );
    expect(denied.status).toBe(404);
  });

  test("does not cache incomplete result projections under the final version ETag", async () => {
    let pending = true;
    productRead.getInvestigation = async (userId) => userId === USER_A
      ? { ...investigationView(), status: "completed", projectionPending: pending } : null;
    const url = `${booted.baseUrl}/api/investigations/${INV}`;
    const first = await fetch(url, { headers: { Authorization: "Bearer token-a" } });
    const etag = first.headers.get("etag")!;
    expect(etag).toContain("-publishing");
    const headers = { Authorization: "Bearer token-a", "If-None-Match": etag };
    expect((await fetch(url, { headers })).status).toBe(200);
    pending = false;
    const published = await fetch(url, { headers });
    expect(published.status).toBe(200);
    expect(published.headers.get("etag")).toBe(`W/"investigation-${INV}-4"`);
    headers["If-None-Match"] = published.headers.get("etag")!;
    expect((await fetch(url, { headers })).status).toBe(304);
  });

  test("returns authorized exact diff data and rejects malformed ids", async () => {
    const response = await fetch(
      `${booted.baseUrl}/api/investigations/${INV}/diff`,
      { headers: { Authorization: "Bearer token-a" } },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      diff: "diff --git a/a.ts b/a.ts\n",
      diffTruncated: false,
    });

    const malformed = await fetch(
      `${booted.baseUrl}/api/investigations/not-an-id`,
      { headers: { Authorization: "Bearer token-a" } },
    );
    expect(malformed.status).toBe(404);
  });
});
