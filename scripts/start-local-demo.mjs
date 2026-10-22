// One repeatable command for the local GitHub-command engine. The saved
// installation selection is non-secret and remains in ignored artifacts.
import { spawn } from "node:child_process";
import { configureLocalDemo } from "./local-demo-env.mjs";
configureLocalDemo();

const run = (script, args = []) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [script, ...args], { stdio: "inherit", env: process.env });
  child.once("error", reject);
  child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${script} exited with code ${code}`)));
});
try {
  await run("scripts/start-local-worker.mjs");
  const { runWorkerHealthCheck } = await import("../lib/backend/worker-health.js");
  const deadline = Date.now() + 60_000;
  while (await runWorkerHealthCheck(process.env, () => {}) !== 0) {
    if (Date.now() >= deadline) throw new Error("The local worker did not become ready. Run npm run worker:check inside the demo container to inspect startup.");
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  await run("scripts/listen-local-commands.mjs", ["--run", ...process.argv.slice(2)]);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Local demo startup failed.");
  process.exitCode = 1;
}
