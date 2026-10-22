# Sherlock demo reliability investigation

Checked October 21, 2026, on `fix/demo-reliability-audit`, based on
`697b7cb`. Changes have only been verified locally; production is deferred.

## Verified findings and repairs

### A correct demo fix was rejected by the generated regression test

The original archive-completed demo reproduces at commit
`23b1c194b6c89fc42f609b7809c4a8afcbbc1f84` of
`Htetty/Demo_Broken_Repo`. Its accepted plan creates and completes a task in
the browser, archives it, and finally requests the completed task list.

`compileDeterministicApiRegressionTest` selected only the final matching
HTTP request and discarded the preceding setup. On a fresh unpatched server
the completed task list was empty, so that generated test unexpectedly
passed. Sherlock rejected the correct patch even though its browser replay
already showed expected behavior.

The compiler now accepts self-contained single-request API plans and
preserves their wait steps. Plans with browser actions or multiple API
requests use the existing regression generator rather than dropping setup
or assuming that session state is unnecessary. Captured GET traffic alone
is also insufficient to substitute for the browser flow. The original
fail-before/pass-after verification gate remains enforced.

Evidence in the ignored local audit directory:

- `artifacts/local-audit/demo-replay.log`: before this repair, the patch
  preflight passed but verification returned
  `rejected_regression_test_failed` / `unexpectedly_passed`.
- `artifacts/local-audit/demo-replay-fixed.log`: after the repair, the same
  saved plan and patch returned `verified`.
- `artifacts/local-audit/inv_1K5F0HP80WRX0CC/`: the successful live run's
  browser evidence and patch-verification artifacts.
- `artifacts/local-audit/demo-proof-latest.json`: concise final proof.

This was a replay of the archived plan, patch, and regression-test source,
not a fresh autonomous diagnosis by a model. The regression test failed as
expected on the original source and passed after patching, with identical
SHA-256 `87eb5045387b8c5ac85ca7f81f655c5230a0c16d3698d3b9112173da05cbba33`.
The demo repository has no declared validation scripts, so those were
reported as unavailable.

### Transient model connection failures were not retried

The inference gateway disables SDK retries and owns retry accounting.
However, `APIConnectionError` inherits from `APIError`, has no HTTP status,
and was classified as permanent `api_error`. SDK connection failures ended
after one attempt. Retryable errors also retried immediately, and a
permanent API error containing “timed out” could be retried incorrectly.

The gateway now classifies SDK connection, timeout, and cancellation types
before generic HTTP errors; uses bounded exponential backoff with jitter;
honors bounded `retry-after-ms` / `retry-after` hints; and avoids sleeping
after terminal errors or the last attempt. SDK retries remain disabled and
attempt accounting remains in the gateway.

The new inference regressions failed before the implementation change and
pass afterward. A separate live smoke request to the configured
`claude-sonnet-5` succeeded with 13 input and 5 output tokens.

### Deployment checks and tests depended on the host OS

- The staging key guard compared a Windows-resolved path to a slash-only
  suffix, allowing the production key path to evade that check on Windows.
  It now normalizes separators before comparison. Existing regression tests
  demonstrate the failure and fix.
- The inference SDK-call guard now converts its file URL with
  `fileURLToPath`, avoiding invalid Windows drive paths.
- Sandbox unit fixtures now explicitly describe a host-run worker rather
  than accidentally inheriting the test runner's container detection.
  Explicit container/network-mode tests still exercise those modes.

### Temporary Docker failures could orphan containers

Container removal failures were swallowed and then the container was removed
from Sherlock's tracking registry anyway. A later shutdown sweep could not
retry it, and the sweep even counted failed removals as successful. A
synchronous command-spawn failure also bypassed cleanup after registration.

Failed removals now stay tracked for another cleanup attempt. The sweep
reports only successful removals, synchronous spawn failures attempt
cleanup, and command timeouts use one awaited removal rather than two
competing removal calls. Four failure-injection regressions failed before
the repair and pass afterward. Evidence: `cleanup-before.json` and
`cleanup-after.json` under `artifacts/local-audit/`.

### Failed page creation leaked an already launched browser

Both deterministic replay and live exploration created a page before
entering their normal close/finally path. If page creation failed after
Chromium launched, the browser was never closed. Both now close it on that
setup failure and preserve the original error if closing also fails.

Four regressions cover replay with and without video recording, live
exploration, and cleanup-error preservation. They failed before the repair
and pass afterward. Evidence: `browser-cleanup-before.json` and
`browser-cleanup-after.json` under `artifacts/local-audit/`.

### A long active job prevented shutdown from removing its sandbox

The actual worker entry point was run in the worker image against a uniquely
named local Redis queue. GitHub authentication and persistence were stubbed,
and a controlled pipeline started a real restricted target container before
waiting indefinitely. No remote service was contacted. With Compose's exact
120-second stop allowance, `worker.close()` never drained: Docker killed the
worker after 120.239 seconds with exit code 137, leaving its target running.
The queued job remained active and a replacement processor recovered it once.
This establishes a sandbox leak, rather than an observation about timeouts.

Shutdown now arms a 90-second deadline while retaining normal graceful
draining. At the deadline, one synchronous Docker argv call attempts to remove
only this process's tracked containers, with a 20-second total timeout, then
the worker exits with code 1. The synchronous path deliberately does not yield
to interrupted pipeline callbacks, which could otherwise publish a false
terminal failure. It does not abort jobs, change attempt budgets, clear
delivery state, or release active leases early. Existing stalled recovery,
delivery idempotency, and lease fencing remain responsible for recovery.

With this repair, the same full worker-image fixture exited after 90.412
seconds, its target was removed, and no delivery/terminal-failure files were
written. The job remained active, its one concurrency lease owner remained
intact, and a replacement processor completed it once. An idle worker still
shut down normally with exit code 0 in 251 milliseconds. Seven new focused
tests cover deadline cancellation, synchronous exit ordering, bounded owned
container removal, and honest removal failure behavior.

Evidence under `artifacts/local-audit/`: `shutdown-before.json` and `.log`,
`shutdown-after.json` and `.log`, `shutdown-idle.json`, and the local
`shutdown-*.mjs` harnesses. The before run predates the new helper; the new
unit tests validate the repair rather than claiming to run against an absent
helper. `worker-image-shutdown-build.log` records the rebuilt actual image.

Limits: the recovery processor is a local stand-in, not a new full model-led
investigation. Existing production concurrency lease expiry can defer a
crashed investigation for up to 30 minutes; this repair preserves that
behavior. Forced exit does not guarantee clone/runtime workspace cleanup.
An earlier SIGKILL, blocked Node event loop, in-flight container creation,
or unavailable Docker daemon can still leave resources. Docker errors are
reported as cleanup failures, not successful removal. Manual worker runs
need the documented 120-second stop timeout.

## Validation completed

| Check | Result |
| --- | --- |
| TypeScript build | Passed |
| Complete test suite in a Linux Playwright container, including real local Redis integration | 827 passed, 0 failed, 0 skipped |
| Worker preflight on this desktop | All mandatory checks passed |
| Live historical demo in restricted Docker containers | Reproduced before patch; verified afterward |
| Production GitHub App key and required write permissions | Verified through the App API |
| Anthropic key/model availability and a small inference call | Verified |
| Git diff whitespace check | Passed |

### Additional local failure and recovery experiments

The actual `Dockerfile.worker` builds successfully. Seven scenario checks
ran in that Linux worker image using Docker sibling containers on a separate
local sandbox network, with no production credentials:

| Scenario | Observed result |
| --- | --- |
| Dynamic app port; root returns 404 but API is healthy | API reproduction executes and observes expected behavior |
| App hardcodes port 3000; browser button enables after a delay | Fixed-port fallback and browser auto-wait work |
| Browser target is absent | Execution failure, not successful verification |
| Async API state checked before completion | Failure reproduced |
| Same API checked after the explicit completion wait | Expected behavior observed |
| App startup exceeds its deadline | Environment failure |
| Cleanup after those runs | No remaining target containers or runtime workspaces |

Evidence: `artifacts/local-audit/scenarios/results.json`, the per-scenario
plans/results/videos, and `container-scenarios.log`.

Five opt-in integration tests use real local Redis and BullMQ:

- Sixteen concurrent copies of one webhook command create one job and
  consume one claim.
- Losing the enqueue acknowledgement releases the claim and permits retry
  without creating a duplicate retained job.
- Durable recovery revives an exhausted, retained delivery-only job.
- A replacement worker recovers a stalled job after the old worker stops
  renewing its lock.
- An expired concurrency owner cannot renew or release its replacement's
  lease.

They pass on Windows and inside the Linux test container, and are included
in the 820-test total above. They use isolated queue prefixes, unique keys,
and no GitHub, Supabase, or model calls. Run them with the documented
`npm run test:integration` command and `SHERLOCK_TEST_REDIS_URL` pointing at
loopback Redis. Evidence: `artifacts/local-audit/redis-recovery.json` and
the complete Linux suite report.

A separate AOF-enabled Redis instance was forcibly restarted while its
client stayed open. All three queued jobs and the webhook deduplication
claim survived; the client reconnected and processed exactly three unique
jobs afterward. The dedicated test container and its anonymous volume were
removed. Evidence: `artifacts/local-audit/redis-restart.json` and
`redis-restart-fixed.log`. The first harness attempt used a randomly
published port, which Docker reassigned during restart; the corrected
experiment publishes an explicit local port. This was a harness issue,
not evidence of a Sherlock regression.

A new verification test also changes a reproduced HTTP 500 to HTTP 403
when the required result is HTTP 401. The loop rejects it as inconclusive
even though the original 500 is gone; a disappearing failure alone does
not establish a verified fix.

Linux is the production platform specified by the deployment runbook.
Earlier Windows runs also exposed POSIX-specific permission, symlink, and
Git line-ending assumptions. The complete Windows suite is not being
reported as passing. Protected-delivery permission checks were preserved.

The isolated Linux test image was built from project source files and the
public mock certificate fixture, without runtime credentials or uploaded
investigation artifacts. Initial runs used networking disabled. The final
run shared the local Redis container's network namespace to enable the
integration tests. No production credentials were provided, and tests used
fixtures rather than production services.
Test output is in `artifacts/local-audit/linux-tests.json` and
`artifacts/local-audit/linux-tests.log`.

## What the uploaded artifacts establish

The uploaded corpus contains 658 root investigation manifests. Of these,
623 reference `acme/private-app`, matching the repository used in unit-test
fixtures. They must not be interpreted as production reliability data.

The 33 `Htetty/Demo_Broken_Repo` runs contain 7 verified fixes, 14 reproduced
failures, 6 environment failures, 3 non-reproductions, 2 planning failures,
and 1 execution failure. Two additional runs concern CreatorVerse.

Specific historical demo failures include:

- July 4: an Anthropic 404 for `claude-sonnet-4-0`
  (`inv_1JSM0UJPCJAV2BN`). The currently configured model is available.
- July 4: startup probes used an allocated port while the application
  reported port 3000 (`inv_1JSM2NLGD6ED9WB`, `inv_1JSN0DSPGB005KD`). The
  existing fixed-port fallback handled this in the new live replay.
- July 6: missing GitHub App Contents permission
  (`inv_1JSQOIJVEPQ3ZKQ`, `inv_1JSQOJ295MXFBW3`,
  `inv_1JSQP7T94B5992M`).

Repository history also contains the July 27 Playwright worker temp/image
repair. These are documented causes of historical failures, but the
available evidence does not identify which run was the failed YC demo.

## Local setup

- Docker Desktop is installed per user. Its CLI is at
  `%LOCALAPPDATA%\Programs\DockerDesktop\resources\bin\docker.exe`; existing
  Codex shell processes did not inherit the installer's PATH update. Audit
  commands added that directory to their own process PATH.
- Local Redis runs in `sherlock-audit-redis`, bound to `127.0.0.1:6379`.
- `node:20-slim`, `sherlock-explorer:latest`, the Playwright base image, and
  `sherlock-audit-tests:local` were prepared locally. The actual worker image
  is also built as `sherlock-audit-worker:local`.
- The gitignored `.env` now points `PRIVATE_KEY_PATH` at the supplied local
  production PEM, sets the previously absent local `REDIS_URL`, and sets
  the verified App slug `sherlock-github-bot`.
- Chromium and Playwright's recording dependency are installed. Optional
  standalone Graphify and ffmpeg commands remain unavailable on Windows.
- `.env`, secret PEMs, and all investigation artifacts remain gitignored.

The demo clone under `artifacts/local-audit/demo-repo` contains the verified
patch for inspection. It was not pushed. All temporary target containers
were removed after verification; the local Redis service remains available.

## Production checks deferred by the user

The current scope is local investigation, fixes, and tests. The user will
test production later. Production credentials are not required for the
current work; the following findings are a later deployment checklist.

1. The supplied Supabase project hostname returns `NXDOMAIN` both locally
   and through Google's public DNS resolver. Its keys' presence is not
   proof that the database or dashboard can run. Obtain a working project
   endpoint and matching configuration, or restore the intended project.
2. The supplied GitHub App authenticates, has the required write
   permissions, and has three active installations. The App API returns
   404 for its installation on `Htetty/Demo_Broken_Repo`, although the
   personal account can read that repository. Confirm or restore App access
   to the intended demo repository before a GitHub-triggered investigation.
3. Both `/healthz` and `/readyz` requests against the configured webhook
   origin timed out. This does not establish the server's root cause.
4. This desktop has SSH known-host files but no SSH private key or host
   configuration. Production container logs and deployment environment
   have not been inspected. Server hostname, username, and an authorized
   key location are needed for that work.
5. The uploaded staging PEM is not a usable RSA private key. Staging is not
   required for the local checks above.

No live worker was started against a production queue, and no webhook was
redelivered. No Supabase data, GitHub issues, remote branches, PRs, or
deployments were changed.

## Completed local handoff

The authorized overnight local pass is complete on October 21. The shutdown
candidate was reproduced and repaired, and the complete Linux suite was rerun
because worker shutdown and cleanup changed: 827 tests pass, including all five
real Redis recovery integrations. TypeScript and the actual worker-image build
also pass. The follow-up schedule is paused; no further overnight runs are
needed. Production checks remain deferred to the user's later testing.

Changes remain local on `fix/demo-reliability-audit`. Original
uploaded artifacts and secrets were preserved. Temporary shutdown workers,
their target containers, fixture directories, and isolated queue/lease keys
were removed after testing. Local Redis remains available for development.
The report and ignored `artifacts/local-audit/` evidence are the review handoff;
no push, merge, GitHub comment, or deployment was performed.
