import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { configureLocalDemo } from "./local-demo-env.mjs";
import { createCommandPoller } from "./local-command-poll.mjs";
import { createInstallationPoller, listCompleteInstallationRepositories } from "./local-installation-poll.mjs";
configureLocalDemo();

const args = process.argv.slice(2);
const option = (flag) => args.includes(flag) ? args[args.indexOf(flag) + 1] : null;
const run = args.includes("--run");
const configPath = path.join(process.env.ARTIFACTS_DIR, "listener-config.json");
const { redactSecrets } = await import("../lib/backend/services/report.js");
let redis;
let lockKey;
const lockOwner = randomUUID();
let lockTimer;
let stopped = false;
let wake;
const stop = () => { stopped = true; wake?.(); };
try {
  let installationId = option("--installation");
  const repoName = option("--repo");
  if (!installationId && !repoName) {
    const config = JSON.parse(await readFile(configPath, "utf8").catch((error) => {
      if (error.code !== "ENOENT") throw error;
      throw new Error("Choose an installation once: npm run demo:listen -- --installation ID --run --save");
    }));
    installationId = String(config.installationId);
  }
  if (installationId && repoName) throw new Error("Choose either --installation or --repo.");
  if (installationId && !/^[1-9][0-9]{0,14}$/.test(installationId)) throw new Error("Invalid installation ID.");
  if (repoName && !/^[\w.-]+\/[\w.-]+$/.test(repoName)) throw new Error("Invalid repository name.");
  const explicitSince = option("--since");
  if (explicitSince && (!Number.isFinite(Date.parse(explicitSince)) || Date.parse(explicitSince) > Date.now())) {
    throw new Error("--since must be a valid past timestamp.");
  }
  const initialStart = explicitSince ? new Date(explicitSince).toISOString() : new Date().toISOString();
  if (run) {
    const { runWorkerHealthCheck } = await import("../lib/backend/worker-health.js");
    if (await runWorkerHealthCheck() !== 0) throw new Error("Start npm run worker:local first.");
    const { Redis } = await import("ioredis");
    redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1, commandTimeout: 5000 });
  }
  const { createProbot } = await import("probot");
  const probot = createProbot({ env: { ...process.env, REDIS_URL: "" } });
  const app = await probot.auth();
  if (repoName) {
    const [owner, repo] = repoName.split("/");
    installationId = String((await app.request("GET /repos/{owner}/{repo}/installation", { owner, repo })).data.id);
  }
  const { data: installation } = await app.request("GET /app/installations/{installation_id}", {
    installation_id: Number(installationId),
  });
  if (installation.suspended_at) throw new Error("Installation is suspended.");
  const github = await probot.auth(Number(installationId));
  if (run) {
    lockKey = `sherlock:local-listener:${installationId}:lock`;
    if (await redis.set(lockKey, lockOwner, "PX", 30_000, "NX") !== "OK") {
      lockKey = null;
      throw new Error("A local listener is already running for this installation.");
    }
    lockTimer = setInterval(() => {
      void redis.eval("if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('pexpire',KEYS[1],30000) else return 0 end", 1, lockKey, lockOwner)
        .then((owned) => { if (Number(owned) !== 1) stop(); }).catch(stop);
    }, 10_000);
    const { default: sherlockApp } = await import("../lib/src/index.js");
    await probot.load(sherlockApp);
  }
  const assertOwnership = async () => {
    if (run && (stopped || await redis.get(lockKey) !== lockOwner)) throw new Error("Listener ownership lost; dispatch stopped.");
  };
  if (args.includes("--save")) {
    if (repoName) throw new Error("--save requires installation-wide scope.");
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({ installationId }, null, 2));
  }
  const { parseSherlockCommand, isBotUser } = await import("../lib/src/command-gate.js");
  const poll = createInstallationPoller({
    listRepositories: async () => {
      await assertOwnership();
      const { data: current } = await app.request("GET /app/installations/{installation_id}", { installation_id: Number(installationId) });
      if (current.suspended_at) return [];
      const repos = await listCompleteInstallationRepositories(async (params) =>
        (await github.rest.apps.listReposAccessibleToInstallation(params)).data);
      return repoName ? repos.filter((r) => r.full_name.toLowerCase() === repoName.toLowerCase()) : repos;
    },
    onScope: (repos) => console.log(`Watching ${repos.length} authorized repositories: ${repos.map((r) => r.full_name).join(", ") || "none"}`),
    onError: (repo, error) => console.error(`Listener retry for ${repo.full_name}: ${redactSecrets(error instanceof Error ? error.message : "request failed")}`),
    createRepoPoller: async (repository) => {
      const [owner, repo] = repository.full_name.split("/");
      const checkpointKey = `sherlock:local-listener:${installationId}:repo:${repository.id}`;
      // Persist the lower bound before the first API call, so a crash or an
      // initial GitHub outage cannot move the start past an unprocessed command.
      if (run) {
        await assertOwnership();
        await redis.set(checkpointKey, JSON.stringify({ startedAt: initialStart, cursor: initialStart }), "NX");
      }
      const saved = run ? await redis.get(checkpointKey) : null;
      const checkpoint = saved ? JSON.parse(saved) : null;
      const startedAt = checkpoint?.startedAt ?? initialStart;
      return createCommandPoller({
        startedAt, checkpoint,
        saveCheckpoint: async (value) => { if (run) { await assertOwnership(); await redis.set(checkpointKey, JSON.stringify(value)); } },
        listPage: async (params) => (await github.rest.issues.listCommentsForRepo({ owner, repo, sort: "created", direction: "asc", ...params })).data,
        isCommand: (comment) => !isBotUser(comment.user) && !!parseSherlockCommand(comment.body || ""),
        handleComment: async (comment) => {
          await assertOwnership();
          const parts = new URL(comment.issue_url).pathname.split("/");
          const issueNumber = Number(parts[5]);
          if (parts.length !== 6 || parts[1] !== "repos" || parts[4] !== "issues"
            || `${parts[2]}/${parts[3]}`.toLowerCase() !== repository.full_name.toLowerCase()
            || !Number.isSafeInteger(issueNumber) || issueNumber < 1) throw new Error("Comment repository identity mismatch.");
          const { data: issue } = await github.rest.issues.get({ owner, repo, issue_number: issueNumber });
          if (issue.pull_request) return;
          if (run) {
            await assertOwnership();
            await probot.receive({ id: `local-demo-comment-${comment.id}`, name: "issue_comment",
              payload: { action: "created", repository, issue, comment, installation: { id: Number(installationId) }, sender: comment.user } });
          }
          console.log(`${run ? "Processed" : "Preview only"}: ${repository.full_name}#${issueNumber}, comment ${comment.id}`);
        },
      });
    },
  });
  console.log(`${run ? "LIVE" : "READ-ONLY"} local listener for installation ${installationId}. ${run ? "Durable Redis checkpoints enabled." : "No writes."}`);
  console.log("Polling every 10 seconds. Keep Docker and this PC running. Ctrl+C stops listening. Shared GitHub App settings are unchanged.");
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  while (!stopped) {
    try { await poll(); }
    catch (error) { console.error(`Listener retry: ${redactSecrets(error instanceof Error ? error.message : "request failed")}`); }
    if (!stopped) await new Promise((resolve) => {
      const timer = setTimeout(resolve, 10_000);
      wake = () => { clearTimeout(timer); resolve(); };
    });
  }
} catch (error) {
  console.error(redactSecrets(error instanceof Error ? error.message : "Local listener failed."));
  process.exitCode = 1;
} finally {
  clearInterval(lockTimer);
  if (redis && lockKey) await redis.eval("if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end", 1, lockKey, lockOwner).catch(() => {});
  redis?.disconnect();
}
process.exit(process.exitCode ?? 0);
