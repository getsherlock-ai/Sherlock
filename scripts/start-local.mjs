// Start the local HTTP API without a webhook relay or queue consumer.
// --dashboard retains configured Supabase auth/data for the real frontend.
// Keep the user's .env untouched; overrides live in this process.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const root = fileURLToPath(new URL("../", import.meta.url));
config({ path: path.join(root, ".env"), quiet: true });
const dashboard = process.argv.includes("--dashboard");
process.env.NODE_ENV = "development";
process.env.ALLOW_SYNC_INVESTIGATIONS = "false";
process.env.WEBHOOK_PROXY_URL = "";
process.env.REDIS_URL = "redis://127.0.0.1:6379";
process.env.SHERLOCK_STATE_STORE = "file";
process.env.ARTIFACTS_DIR = path.join(root, "artifacts", "local-dev");
process.env.SHERLOCK_STATE_STORE_DIR = path.join(process.env.ARTIFACTS_DIR, "_state");
process.env.SHERLOCK_PUBLIC_REPLAY_UPLOAD_MODE = "disabled";
process.env.SHERLOCK_FRONTEND_URL = "http://localhost:3000";
if (!dashboard) {
  for (const name of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_ANON_KEY"]) {
    process.env[name] = "";
  }
}

const port = Number(process.env.BACKEND_PORT || 4000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("BACKEND_PORT must be an integer between 1 and 65535.");
}
if (dashboard) {
  // Probot also uses REDIS_URL for GitHub request throttling. Without Redis,
  // sign-in and cached repository reads work but live issue reads hang.
  const { Redis } = await import("ioredis");
  const redis = new Redis(process.env.REDIS_URL, {
    lazyConnect: true,
    connectTimeout: 1_500,
    commandTimeout: 1_500,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });
  redis.on("error", () => {});
  try {
    await redis.connect();
    await redis.ping();
  } catch {
    console.error("Dashboard mode needs local Redis at 127.0.0.1:6379 for GitHub requests.");
    console.error("Open Docker Desktop, run npm run redis:up, then retry npm run dev:dashboard.");
    process.exitCode = 1;
  } finally {
    redis.disconnect();
  }
  if (process.exitCode === 1) process.exit(1);
}
const { createApp } = await import("../lib/backend/server.js");
const app = createApp();
app.get("/", (_request, response) => response.json({
  service: "Sherlock local backend",
  health: "/healthz",
  guide: "docs/local-testing.md",
  mode: dashboard ? "dashboard" : "isolated",
  note: "API only. Webhook bot and investigation worker are not started. No investigation is running.",
}));
const server = app.listen(port, "127.0.0.1", () => {
  console.log(`Sherlock local API: http://127.0.0.1:${port}`);
  console.log(`Health check:      http://127.0.0.1:${port}/healthz`);
  console.log("Webhook bot and investigation worker are not started.");
  console.log(dashboard
    ? "Dashboard mode uses configured Supabase auth and product data. Frontend: http://localhost:3000"
    : "Remote persistence is disabled in this isolated local session.");
  console.log("Direct investigation requests and public replay uploads are disabled.");
  console.log("Press Ctrl+C to stop. See docs/local-testing.md for testing instructions.");
});
server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${port} is already in use. Stop the previous server or set BACKEND_PORT to another port.`);
  } else {
    console.error("Local API could not start. Check the local port and build output.");
  }
  process.exitCode = 1;
});
