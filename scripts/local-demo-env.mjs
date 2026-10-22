import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

// Shared by the local worker and the explicit, one-comment demo replay.
// The normal backend/dashboard queue (DB 0) and hosted queues stay separate.
export function configureLocalDemo() {
  const root = fileURLToPath(new URL("../", import.meta.url));
  process.chdir(root);
  config({ path: path.join(root, ".env"), quiet: true });
  process.env.NODE_ENV = "development";
  process.env.REDIS_URL = "redis://127.0.0.1:6380/13";
  process.env.WEBHOOK_PROXY_URL = "";
  process.env.ARTIFACTS_DIR = path.join(root, "artifacts", "local-demo");
  process.env.SHERLOCK_STATE_STORE_DIR = path.join(process.env.ARTIFACTS_DIR, "_state");
  process.env.SHERLOCK_STATE_STORE = "file";
  process.env.SHERLOCK_PUBLIC_REPLAY_UPLOAD_MODE = "disabled";
  process.env.SHERLOCK_WORKER_CONTAINERIZED = "false";
  process.env.SHERLOCK_RUN_STARTUP_CHECKS = "true";
  process.env.SHERLOCK_WORKER_ID = "sherlock-local-demo";
  delete process.env.SHERLOCK_HOST_TMP;
  delete process.env.SHERLOCK_SANDBOX_NETWORK;
  if (process.env.LOCALAPPDATA) {
    process.env.PATH = path.join(process.env.LOCALAPPDATA, "Programs", "DockerDesktop", "resources", "bin")
      + path.delimiter + (process.env.PATH || "");
  }
}
