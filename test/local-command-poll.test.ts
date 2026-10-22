import { expect, test, vi } from "vitest";
// @ts-expect-error Local development scripts are intentionally outside tsc's source tree.
import { createCommandPoller } from "../scripts/local-command-poll.mjs";
import { isBotUser, parseSherlockCommand } from "../src/command-gate.js";
// @ts-expect-error Local development scripts are intentionally outside tsc's source tree.
import { createInstallationPoller, listCompleteInstallationRepositories } from "../scripts/local-installation-poll.mjs";

const startedAt = "2026-10-22T03:00:00.000Z";
const start = Date.parse(startedAt);
const command = (id: number, offset = 1_000) => ({ id, created_at: new Date(start + offset).toISOString(),
  updated_at: new Date(start + offset).toISOString(), user: { type: "User", login: "demo" }, body: "/sherlock investigate" });
const isCommand = (c: ReturnType<typeof command>) => !isBotUser(c.user) && !!parseSherlockCommand(c.body);

test("overlapping polls dispatch new exact human commands once and ignore old edits, bots, and prose", async () => {
  const handleComment = vi.fn();
  const old = { ...command(1, -1_000), updated_at: new Date(start + 5_000).toISOString() };
  const listPage = vi.fn().mockResolvedValue([old, command(2), { ...command(3), user: { type: "Bot" } },
    { ...command(4), body: "please /sherlock investigate later" }]);
  const poll = createCommandPoller({ startedAt, listPage, isCommand, handleComment, now: () => start + 10_000 });
  await poll(); await poll();
  expect(handleComment.mock.calls.map(([c]) => c.id)).toEqual([2]);
});

test("all pages are handled, including separate commands on the same issue", async () => {
  const handleComment = vi.fn();
  const listPage = vi.fn().mockImplementation(async ({ page }) => page === 1
    ? Array.from({ length: 100 }, (_, i) => command(i + 1)) : [command(101)]);
  await createCommandPoller({ startedAt, listPage, isCommand, handleComment })();
  expect(handleComment).toHaveBeenCalledTimes(101);
  expect(listPage).toHaveBeenCalledTimes(2);
});

test("failed dispatch retains cursor, retries failed item, and does not repeat earlier successes", async () => {
  const handleComment = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue(undefined);
  const listPage = vi.fn().mockResolvedValue([command(1), command(2)]);
  const poll = createCommandPoller({ startedAt, listPage, isCommand, handleComment, now: () => start + 180_000 });
  await expect(poll()).rejects.toThrow("offline");
  await poll();
  expect(handleComment.mock.calls.map(([c]) => c.id)).toEqual([1, 2, 2]);
  expect(listPage.mock.calls[0][0].since).toBe(listPage.mock.calls[1][0].since);
});

test("API failure and pagination overflow never advance the cursor", async () => {
  const listPage = vi.fn().mockRejectedValueOnce(new Error("API failed"))
    .mockResolvedValueOnce(Array.from({ length: 100 }, (_, i) => command(i)))
    .mockResolvedValueOnce([]);
  const poll = createCommandPoller({ startedAt, listPage, isCommand, handleComment: vi.fn(),
    maxPages: 1, now: () => start + 180_000 });
  await expect(poll()).rejects.toThrow("API failed");
  await expect(poll()).rejects.toThrow("page limit");
  await poll();
  expect(listPage.mock.calls.map(([p]) => p.since)).toEqual([startedAt, startedAt, startedAt]);
});

test("restart resumes a durable cursor and picks up commands posted while stopped", async () => {
  let checkpoint: { startedAt: string; cursor: string } | null = null;
  const saveCheckpoint = vi.fn(async (value) => { checkpoint = value; });
  const first = createCommandPoller({ startedAt, listPage: async () => [], isCommand,
    handleComment: vi.fn(), saveCheckpoint, now: () => start + 180_000 });
  await first();
  const listPage = vi.fn().mockResolvedValue([command(9, 240_000)]);
  const handleComment = vi.fn();
  await createCommandPoller({ startedAt, checkpoint, listPage, isCommand, handleComment,
    saveCheckpoint, now: () => start + 300_000 })();
  expect(listPage).toHaveBeenCalledWith(expect.objectContaining({ since: new Date(start + 120_000).toISOString() }));
  expect(handleComment).toHaveBeenCalledWith(expect.objectContaining({ id: 9 }));
  expect(saveCheckpoint).toHaveBeenLastCalledWith({ startedAt, cursor: new Date(start + 300_000).toISOString() });
});

test("checkpoint failure cannot advance past an unrecorded poll", async () => {
  const listPage = vi.fn().mockResolvedValue([command(1)]);
  const handleComment = vi.fn();
  const saveCheckpoint = vi.fn().mockRejectedValueOnce(new Error("disk unavailable")).mockResolvedValue(undefined);
  const poll = createCommandPoller({ startedAt, listPage, isCommand, handleComment, saveCheckpoint,
    now: () => start + 180_000 });
  await expect(poll()).rejects.toThrow("disk unavailable");
  await poll();
  expect(listPage.mock.calls[0][0].since).toBe(listPage.mock.calls[1][0].since);
  expect(handleComment).toHaveBeenCalledTimes(1);
});

const repo = (id: number, name = `demo/repo-${id}`) => ({ id, full_name: name });

test("installation listener follows all selected repositories including additions, revocation and renames", async () => {
  const listRepositories = vi.fn().mockResolvedValueOnce([repo(1), repo(2), repo(3)])
    .mockResolvedValueOnce([repo(1), repo(3), repo(4)])
    .mockResolvedValueOnce([repo(1, "demo/renamed"), repo(3), repo(4)])
    .mockResolvedValueOnce([]);
  const dispatched: string[] = [];
  const createRepoPoller = vi.fn(async (r) => async () => { dispatched.push(r.full_name); });
  const poll = createInstallationPoller({ listRepositories, createRepoPoller });
  await poll(); await poll(); await poll(); await poll();
  expect(dispatched).toEqual(["demo/repo-1", "demo/repo-2", "demo/repo-3",
    "demo/repo-1", "demo/repo-3", "demo/repo-4", "demo/renamed", "demo/repo-3", "demo/repo-4"]);
  expect(createRepoPoller).toHaveBeenCalledTimes(5);
});

test("one repository failure does not prevent commands in the other selected repositories", async () => {
  const handle = vi.fn();
  const onError = vi.fn();
  const poll = createInstallationPoller({ listRepositories: async () => [repo(1), repo(2)], onError,
    createRepoPoller: async (r) => async () => { if (r.id === 1) throw new Error("offline"); handle(r.id); } });
  await poll();
  expect(handle).toHaveBeenCalledWith(2);
  expect(onError).toHaveBeenCalledTimes(1);
});

test("failed discovery cannot dispatch cached repositories with unknown current access", async () => {
  const listRepositories = vi.fn().mockResolvedValueOnce([repo(1)]).mockRejectedValueOnce(new Error("API unavailable"));
  const handle = vi.fn();
  const poll = createInstallationPoller({ listRepositories, createRepoPoller: async () => handle });
  await poll();
  await expect(poll()).rejects.toThrow("API unavailable");
  expect(handle).toHaveBeenCalledTimes(1);
});

test("repository discovery requires every page and rejects partial snapshots", async () => {
  const hundred = Array.from({ length: 100 }, (_, i) => repo(i));
  const listPage = vi.fn().mockResolvedValueOnce({ repositories: hundred, total_count: 101 })
    .mockResolvedValueOnce({ repositories: [repo(100)], total_count: 101 });
  expect(await listCompleteInstallationRepositories(listPage)).toHaveLength(101);
  await expect(listCompleteInstallationRepositories(async () => ({ repositories: [], total_count: 1 })))
    .rejects.toThrow("changed during pagination");
  await expect(listCompleteInstallationRepositories(async () => ({ repositories: hundred }), 1))
    .rejects.toThrow("page limit");
});
