import { configureLocalDemo } from "./local-demo-env.mjs";
import { spawn } from "node:child_process";
configureLocalDemo();

// Protected delivery files require real POSIX permissions. A Windows host
// cannot provide those chmod semantics; use the production Linux worker
// with a named artifacts volume instead of weakening the file checks.
const compose = ["compose", "--project-name", "sherlock-local-demo", "--env-file", ".env", "-f", "compose.demo.yml"];
const args = process.argv.includes("--stop")
  ? [...compose, "stop"]
  : process.argv.includes("--check")
    ? [...compose, "exec", "-T", "worker", "node", "./lib/backend/worker-preflight.js"]
    : [...compose, "up", "-d", ...(process.argv.includes("--build") ? ["--build"] : [])];
console.log(process.argv.includes("--stop")
  ? "Stopping local demo containers; durable volumes are retained."
  : process.argv.includes("--check")
    ? "Checking the running Linux demo worker."
    : "Starting the Linux demo worker and its isolated Redis on loopback port 6380. Webhook settings are unchanged.");
const child = spawn("docker", args, { stdio: "inherit", env: process.env });
child.on("error", () => { console.error("Docker could not start. Open Docker Desktop and retry."); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });
