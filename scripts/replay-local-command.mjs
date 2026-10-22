// Read a real, already-posted command and pass it through the actual Probot
// handler. Defaults to read-only inspection; --run explicitly enqueues it and
// permits the normal queued comment, model work, and GitHub fix delivery.
import { configureLocalDemo } from "./local-demo-env.mjs";
configureLocalDemo();

const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
const repo = args.includes("--repo") ? option("--repo") : "";
const issueNumber = args.includes("--issue") ? Number(option("--issue")) : NaN;
const run = args.includes("--run");
if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isSafeInteger(issueNumber) || issueNumber < 1) {
  console.error("Usage: node scripts/replay-local-command.mjs --repo owner/name --issue 13 [--run]");
  process.exit(1);
}
const [owner, name] = repo.split("/");
try {
  const { createProbot } = await import("probot");
  // No Redis-backed throttle connection is needed for the read-only preview.
  const probot = createProbot({ env: { ...process.env, REDIS_URL: "" } });
  const app = await probot.auth();
  const { data: installation } = await app.request("GET /repos/{owner}/{repo}/installation", { owner, repo: name });
  if (installation.suspended_at) throw new Error("Installation is suspended.");
  const github = await probot.auth(installation.id);
  const [{ data: repository }, { data: issue }] = await Promise.all([
    github.rest.repos.get({ owner, repo: name }),
    github.rest.issues.get({ owner, repo: name, issue_number: issueNumber }),
  ]);
  if (issue.pull_request) throw new Error("The selected item is a pull request, not an issue.");
  const { parseSherlockCommand } = await import("../lib/src/command-gate.js");
  const comments = [];
  for (let page = 1; page <= 10; page++) {
    const { data } = await github.rest.issues.listComments({ owner, repo: name, issue_number: issueNumber, per_page: 100, page });
    comments.push(...data);
    if (data.length < 100) break;
    if (page === 10) throw new Error("Too many comments for a controlled demo replay.");
  }
  // Use the most recent genuine human-authored command on this exact issue.
  const comment = comments.filter((c) => c.user?.type === "User" && parseSherlockCommand(c.body || "")).at(-1);
  if (!comment) throw new Error("No human-authored /sherlock investigate command exists on this issue.");
  console.log(JSON.stringify({ mode: run ? "run" : "read-only-preview", repository: repository.full_name,
    issueNumber, commentId: comment.id, author: comment.user.login, redisDatabase: 13,
    webhookSettingsChanged: false }));
  if (run) {
    const { default: sherlockApp } = await import("../lib/src/index.js");
    await probot.load(sherlockApp);
    await probot.receive({
      id: `local-demo-comment-${comment.id}`, name: "issue_comment",
      payload: { action: "created", repository, issue, comment,
        installation: { id: installation.id }, sender: comment.user },
    });
    console.log("The actual webhook handler processed the command; check GitHub and the local worker logs for its disposition.");
  } else {
    console.log("Preview only: no comments, queue jobs, model calls, or PRs were created.");
  }
  // Probot's handler opens queue clients when --run is requested. The awaited
  // handler has already acknowledged enqueue/deduplication before this exit.
  process.exit(0);
} catch (error) {
  const { redactSecrets } = await import("../lib/backend/services/report.js");
  console.error(redactSecrets(error instanceof Error ? error.message : "Local demo inspection failed."));
  process.exit(1);
}
