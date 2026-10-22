# RecipeBox fixer assessment

Assessed locally on October 21, 2026, on `fix/demo-reliability-audit`.
The original run and uploaded artifacts were preserved.

## Confirmed cause

Investigation `inv_C51B58BAB26C63F43DA9` reproduced the bug in
`Htetty/Test-Repo-RecipeBox#13` at commit
`920842c470412f2c1e7ad27464eb6586fe48d117`.

The first model patch changed case-sensitive prefix matching to
case-insensitive substring matching. The verifier correctly rejected it:
matching records existed (`total: 2`) but pagination still returned no items.
The second model patch addressed both filtering and pagination. Its original
`oldText` matches the LF source exactly; it was not an invented source edit.

The authenticated clone intentionally ignores host Git configuration and
initially checks out LF source. Later `git checkout -- .` rollback commands
ran in the host environment. On this PC, inherited `core.autocrlf=true`
rewrote the source as CRLF. The initial source supplied to the fixer was
therefore no longer byte-for-byte accurate, even though the commit and clean
working-tree checks still passed. Exact patch validation rejected the second
proposal because its LF text no longer matched the CRLF worktree.

## Repair

Both clone paths now persist `core.autocrlf=false` and `core.eol=lf` in the
**disposable clone's local Git configuration**, before its initial checkout.
Later rollbacks use the same defaults. The user's Git settings are untouched,
and explicit repository `.gitattributes` line-ending rules remain respected.

Patch matching, path/size restrictions, rollback, reproduction checks,
regression proof, and agent budgets were not relaxed or increased.

## Evidence

- Three new real-Git regressions use a temporary, isolated host configuration.
  Both branch-specific and default-branch clone tests failed before the repair:
  rollback changed LF bytes to CRLF and invalidated an otherwise valid edit.
  They pass after the repair. The explicit CRLF `.gitattributes` case passes
  in both versions. The temporary host configuration remains unchanged.
- The existing fixer test fixture now uses the same checkout defaults as
  production clones. All 34 focused repository/fixer tests pass on Windows.
- The complete Linux suite passes **832 tests, zero failures or skips**,
  including the five real local Redis recovery integrations.
- The local Linux worker uses the repaired compiled source through read-only
  source mounts; its dependency image is reused for normal code iteration.

Evidence lives in ignored `artifacts/local-audit/`: `line-endings-before.json`,
`line-endings-after.json`, `linux-tests.json`, and the verification replay logs.

## Exact original proposals now verify

The original two model proposals were replayed unchanged against the real
RecipeBox source and restricted Docker sandboxes on this Windows host. The
first remained correctly rejected because its pagination behavior still
failed. With consistent clone/rollback bytes, the second passed patch safety,
the exact saved API reproduction, and deterministic regression proof. The
same regression script failed on the original source and passed after the
patch, with SHA-256
`8ab3ea1e1eec934ff63c0b167fc09c7e99bd0117a55a5edc1c7129993cf1638f`.
The repository declares no validation scripts; those were reported unavailable.

Evidence: `fixer-proposals-proof.json`, `fixer-proposals-replay.log`, and
`inv_1K5GNJJAF0EAZ0H/` under `artifacts/local-audit/`. This is a replay of
the original proposals, not new model authorship. An earlier proof run hit a
dependency-install timeout; its evidence is retained as
`fixer-proposals-install-timeout.*`. The successful focused proof disabled
npm's optional audit request through the existing target-env allowlist;
production install commands and verification gates were unchanged.

## Reporting crash after restart failure

A separate fresh model-led assessment hit an app restart/install failure.
Restart correctly stopped the previous sandbox and returned an error, but
optional diagnostic reporting then dereferenced the now-null session. That
converted an already reproduced bug into a generic `execution_failed` result.

The pipeline now retains the initial startup evidence and uses it for analysis
when no current sandbox exists. A surviving/restarted session is still
preferred. Two pipeline regressions exercise both cases with controlled
model, browser, and sandbox adapters. The failed-restart case failed before
the fix and passes afterward, preserving `reproduced`, its rejected-build
reason, and one terminal-result callback. No extra patch is accepted.

Evidence: `pipeline-restart-before.json` and `fixer-repair-focused.json`.
All 36 focused tests pass. These assessments do not publish a new GitHub
comment or PR, and do not overwrite the earlier issue #13 run.

## Fresh-run limit remains

A final fresh, unassisted assessment with both code repairs loaded did not
reach the fixer: one-shot planning proposed UI targets absent from the live
DOM, and the reproducer fallback exhausted its 16-turn budget without
submitting a plan (`reproducer_no_submission`, final `plan_failed`). It used
the standard budgets; those were not raised. This is a separate planning
reliability issue, not evidence that the original patch is invalid.

Evidence: `fixer-fresh-final-proof.json` and
`fixer-live-assessment-repaired.log` under `artifacts/local-audit/`.
The fresh check made model calls and read the public repository, but no
GitHub writes or Supabase writes. It also excluded npm's optional audit
request for this local assessment. The result must not be reported as a
fresh autonomous fix success. Automatic webhook forwarding to the PC remains
unchanged as well.

## Issue #14: application startup timeout

The subsequent real command on issue #14 created
`inv_741B198F4B3C783E37CF`. Its worker remained running when the chat was
interrupted. It completed with `environment_failed`, not a reproduction
failure: the target container's `npm install` exceeded its 180-second limit.
The original report and delivered GitHub result are preserved.

A paired check used fresh runtime copies of the same RecipeBox commit,
`920842c470412f2c1e7ad27464eb6586fe48d117`, in the real restricted Linux
target containers. Default installation downloaded its package archives
successfully but timed out at 180,356 ms. The identical install with only
`--no-audit` added installed all 105 packages in 4,566 ms. While the default
process waited, its npm debug log showed an audit bulk request with no
completed audit response. This isolates the optional audit path as the
startup blocker on this PC; it does not establish an npm-wide outage.

Application startup and verification installs now use `npm install
--no-audit`. Dependency installation, lifecycle scripts, sandbox restrictions,
timeouts, reproduction checks, and regression verification still run.
Dependency vulnerability auditing is excluded from these behavioral runs.
The actual repaired sandbox started this same unpatched application in
6,895 ms and returned HTTP 200 for `/api/recipes?q=pasta`, with the original
empty-results bug still present. That startup proof made no model calls,
GitHub writes, or Supabase writes.

The complete Linux suite then passed **836 tests, no failures or skips**,
including the real Redis recovery integrations and four new local listener
checks. The TypeScript build and diff whitespace check pass. An additional
native Windows run of `fix.test.ts` hit its existing POSIX/symlink and
checkout-fixture assumptions (11 failures); the same tests pass on the
worker's Linux platform. No Windows test failures were counted as passes.

Evidence is in ignored `artifacts/local-audit/issue-14/`:
`investigation.json`, `default.json`, `no-audit.json`, `startup-after.json`,
and `linux-tests.json`. The local worker was restarted after its prior job
completed and passed every mandatory preflight check with the repaired code.
The failed historical investigation was not reset or rewritten. A new
command comment creates a fresh investigation.

For local ingress, `npm run demo:listen -- --repo
Htetty/Test-Repo-RecipeBox --run` now polls new commands for that explicitly
selected repository through the real handler. It was started on this PC;
the shared GitHub App webhook remains unchanged. See
[local testing](local-testing.md) for its startup, stop, and downtime limits.

## Successful fresh run and dashboard publication race

The next genuine local command, on RecipeBox issue #15, completed a fresh
model-led investigation: `inv_D76EB97CF3DB5BF83BFC`. It reproduced the search
bug, verified its second patch (`fix_1K5GP1K3IHC7XCF`) against the exact saved
replay, and proved the generated regression failed before/passed after with
identical bytes. Delivery created
[PR #16](https://github.com/Htetty/Test-Repo-RecipeBox/pull/16).
This run supplies the autonomous success that the earlier focused repair
assessments did not establish; it does not guarantee every future model run.

The dashboard initially showed completion with no replay, diff, screenshots,
or PR. All of those were correctly saved: the private bucket contained both
videos and screenshots, the result contained the verified diff, and delivery
had the PR URL. Reloading the actual signed-in browser displayed everything.
The cause was completion being recorded before result/media publication;
the frontend stopped polling at execution completion and retained the empty
snapshot until its much later signed-media refresh. The version-only ETag
also could not represent these independently written projections.

The detail API now reports `projectionPending` until the result, explicit
before/after media availability records, and delivery have settled. Missing
media records mean publication is pending; explicit unavailable/error records
are final states. Pending responses bypass conditional 304 handling and use
a distinct ETag suffix. The frontend continues unconditional polling through
publication and shows a loading message, then stops regular polling when
publication settles. Existing authorization and private signed media access
are preserved; public replay uploads remain disabled for local demos.

A frontend regression reproduces the empty terminal snapshot and fails
before the repair. It now loads replay, diff, and PR at the same execution
version and stops polling afterward. All **42 frontend tests** and **14
focused backend tests** pass, including pending-media, unavailable-media,
pending-delivery, cache, and authorization checks. Both TypeScript checks
and both repository whitespace checks pass. Changes remain local.
