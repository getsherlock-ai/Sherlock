# Start Sherlock locally on this PC

This checkout is the backend. The dashboard frontend is in the sibling
`C:\Users\Htet\Desktop\Work\Sherlock\frontend` repository.
Sherlock's complete GitHub workflow has an HTTP API, a webhook bot, a Redis
queue, and an investigation worker. Start with the API below.

## Website and dashboard demo

Open Docker Desktop first. Dashboard mode needs local Redis because Probot
uses it to throttle live GitHub requests, including reading repository issues.
Without it, sign-in and repository lists can work while issue reads time out.

Start local Redis (if the audit container already exists, `docker start
sherlock-audit-redis` reuses it). Otherwise, from the backend folder run
`npm run redis:up`. Only one Redis container should publish port 6379.

In the first PowerShell terminal:

```powershell
cd C:\Users\Htet\Desktop\Work\Sherlock\backend
npm run dev:dashboard
```

In a second PowerShell terminal:

```powershell
cd C:\Users\Htet\Desktop\Work\Sherlock\frontend
npm run dev
```

Open **http://localhost:3000**, click **Log In**, and sign in with GitHub.
This mode uses the configured Supabase auth and dashboard data. Frontend
`.env.local` must point `SHERLOCK_API_URL` at the local backend (for example,
`http://127.0.0.1:4000`) and use the same Supabase project/publishable key as
the backend. The Supabase Auth
redirect allow list must permit `http://localhost:3000/auth/callback`.
The backend launcher sets the local frontend callback origin for this process.
Keep both terminals open; stop each with Ctrl+C.

Opening a connected repository should show its issues or an empty-state
message. Refresh after creating an issue on GitHub. A new issue alone does
not start an investigation: the exact trigger comment is **`/sherlock investigate`**.
Processing that command additionally requires the webhook bot,
local Redis, the investigation worker, and webhook forwarding to that bot.
The dashboard launcher does not start either bot or worker. A command sent
to the currently deployed GitHub App webhook does not automatically reach
your local backend.

Only repositories authorized for the GitHub App appear. If the intended demo
repository is missing, use **Manage GitHub access** to review its selection.
No App permissions or installations are changed by these startup commands.

After changing repository selection, return to the local dashboard tab.
The sidebar refreshes the signed-in user's existing installations directly
from GitHub on startup and browser focus/visibility return. This refresh
updates Sherlock's stored repository projection; it grants no installation
membership or GitHub permission. Manage-access links open in another tab so
the dashboard remains available while editing GitHub settings. The GitHub
App's shared setup return URL still points to the hosted API; an unavailable
hosted callback does not undo GitHub's saved selection. Local refresh no
longer depends on that callback or a hosted webhook being reachable.

The saved local listener now follows installation 148577457's repository
selection, including all three authorized demo repositories. Selection changes
are discovered on its next poll; the dashboard and listener follow the same
GitHub installation. Shared hosted webhook/setup URLs remain unchanged.

## 1. Open PowerShell and start the API

```powershell
cd C:\Users\Htet\Desktop\Work\Sherlock\backend
npm run dev:local
```

Leave that terminal open. The command builds TypeScript and starts the API
on loopback port 4000 (or the configured `BACKEND_PORT`). It prints the exact
address. This PC already has Node and installed dependencies. On a fresh
checkout, run `npm ci` once before starting.

Open **http://127.0.0.1:4000/healthz** in a browser. Success looks like:

```json
{"status":"ok"}
```

The root URL also shows a small JSON description of the local service. This
is an API, so it does not display the dashboard. Stop it with **Ctrl+C**.
If port 4000 is busy, stop the earlier server or use another port:

```powershell
$env:BACKEND_PORT = "4001"
npm run dev:local
```

Docker and Redis are not required for this initial API check.

The launcher reads `.env` but does not modify it. It overrides remote
Supabase configuration, public uploads, webhook forwarding, and direct
investigation requests in its own process. It starts neither a bot nor a
worker. Protected dashboard APIs and `/readyz` may report missing/not-ready
configuration in this mode; `/healthz` confirms only HTTP process health.

## 2. Check the repaired code

Open a second PowerShell terminal in the same folder:

```powershell
$env:DOTENV_CONFIG_PATH = ".env.test.disabled"
npm run test:local
```

Success is **72 passed** and exit code 0. These focused checks use
controlled fixtures, without model, GitHub, Supabase, or Docker calls. The
complete production-platform Linux suite previously passed 827 tests; the
focused command is a quicker local check, not that complete Linux run.

## 3. Run an investigation

An actual new investigation is a separate step: it needs Docker Desktop,
target containers, a repository, and model calls. The queued GitHub workflow
also needs Redis, the separate worker, and webhook delivery to the bot.
`npm start` starts the API and webhook bot; it does not start the worker.
It can connect a configured webhook relay, so it is not the isolated launcher
above. Do not start the supplied production configuration as a local test.

The already verified archive-completed demo used a saved plan and patch.
A fresh acceptance test should start from the issue description, reproduce
the original bug, generate a patch, then show that the same reproduction and
regression test pass afterward. That fresh model-led test and production
testing remain pending. Starting the API is not evidence of a full successful
investigation.

## Controlled local test of an already-posted command

### Automatically receive new demo commands on this PC

With Docker Desktop open, start the local investigation engine in a terminal:

```powershell
cd C:\Users\Htet\Desktop\Work\Sherlock\backend
npm run demo:local
```

This builds the backend, starts/reuses the Linux worker and local demo Redis,
waits for a fresh worker heartbeat, then starts the listener. Its saved
installation selection lives in ignored
`artifacts/local-demo/listener-config.json`. For a new local checkout, select
an existing authorized installation once with `npm run demo:local --
--installation ID --save`. No GitHub permission or installation membership is
created by that command.

The listener discovers the installation's current repositories on each poll,
then reads their issue comments every 10 seconds. Exact human-authored
`/sherlock investigate` comments pass through the real handler, including live
permission checks, rate limits, and durable comment deduplication. Normal
processing can make model calls, post bot comments, and create a verified fix
PR. It does not change the shared App webhook or installation settings.
`npm run demo:listen` alone is a read-only preview; `demo:local` explicitly runs
the live engine. `--repo owner/name` is available for intentional narrow tests.

Keep the listener, Docker, and the PC running. Ctrl+C stops the listener.
After an initial successful startup, per-repository cursors in the AOF Redis
volume survive restarts and catch comments posted while the listener was
stopped. Initial cursors are saved before reading GitHub, so an initial API
failure cannot skip that window. First-ever startup begins at the current
time; `--since ISO_TIMESTAMP` can explicitly recover an earlier window for
repositories without saved cursors. Existing saved cursors take precedence.
Overlapping reads tolerate brief API visibility delays. Extended GitHub
visibility delays and deletion of the Redis volume remain practical limits.
A lease prevents two listeners for the same installation; a crashed listener's
lease expires within 30 seconds. The listener requires a fresh local worker
heartbeat before live startup.
When both polling and webhook delivery are eventually connected, the handler's
comment identity prevents duplicate investigations.

### Replay one existing command

The GitHub App currently sends webhooks to the hosted API. Running the
dashboard locally does not redirect those events. For a local demo without
changing shared App settings, use the real command handler's explicit replay:

```powershell
cd C:\Users\Htet\Desktop\Work\Sherlock\backend
node scripts/replay-local-command.mjs --repo Htetty/Test-Repo-RecipeBox --issue 13
```

That is a read-only preview: it verifies App access and reads the most recent
human-authored `/sherlock investigate` comment on this exact issue. It sends
no comments, creates no queue job, and makes no model calls.

For actual execution, first run `npm run worker:local`,
then repeat the command with `--run` appended. That explicitly permits the
normal queued response, model investigation, and GitHub fix delivery, which
may create a PR. It passes the original GitHub comment to the actual Probot
handler; existing command authorization and durable deduplication remain in
place. The helper does not invent an issue or bypass the command gate.

The startup command builds the actual Linux worker image and starts it in
Docker with an isolated Redis on **loopback port 6380, database 13**. The
worker must run on Linux: protected delivery storage requires POSIX file
permissions that native Windows cannot provide. Artifacts use the durable
`sherlock-local-demo_demo-artifacts` Docker volume, not a Windows bind mount.
Dashboard Redis remains on port 6379; hosted queues are separate.
Configured Supabase dashboard persistence remains enabled; public replay
uploads remain disabled. No webhook URL or App installation is changed.
The replay processes one comment; use `demo:local` above for normal operation.
The containers run in the background. Check them with
`node scripts/start-local-worker.mjs --check`, or stop them with
`node scripts/start-local-worker.mjs --stop`. Stopping retains durable volumes.
Normal startup compiles TypeScript and mounts the compiled source read-only
into the Linux worker, reusing its dependency image. After dependency or
Dockerfile changes, use `node scripts/start-local-worker.mjs --build` to
rebuild that image. See [the fixer assessment](fixer-repair.md) for the
subsequent line-ending/rollback repair and its verification evidence.

### First live local demo result

On October 21, the user authorized the existing command on
`Htetty/Test-Repo-RecipeBox#13` (comment `6330867391`). The genuine handler
created `inv_C51B58BAB26C63F43DA9`. A fresh model-generated reproduction
confirmed `GET /api/recipes?q=pasta` returned empty results. Both candidate
patches were rejected: one still reproduced the failure; the other did not
match the checked-out source. No fix was marked verified and no PR was made.

The first native Windows worker then failed protected terminal-payload
persistence. The original payload and its SHA-256 were preserved. The worker
was moved to the actual Linux image and a named POSIX volume. A one-off
delivery-only recovery verified the original job identity and payload digest,
rebuilt the delivery ledger from the original `reproduced` report with
`fixVerified=false`, and queued delivery. The model/pipeline was not rerun.
The worker updated the original canonical GitHub comment with **Failure
reproduced; no verified fix**. The delivery job completed. This confirms live
reproduction and result delivery, not autonomous fix success.
