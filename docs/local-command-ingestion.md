# Local command ingestion across authorized repositories

The original local listener was explicitly scoped to RecipeBox, while the
dashboard displayed all three repositories authorized on installation
148577457. The user's genuine `/sherlock investigate` on
`Htetty/Demo_Broken_Repo#120` (comment 6332009480, created 2026-10-22
03:32:42 UTC) therefore received no local response. This was an ingress
configuration gap, not a malformed command or a user error.

The listener now supports one installation's complete current repository
selection. Every poll verifies the installation, retrieves its complete list,
and polls every selected repository. Removed repositories stop being polled;
renamed repositories retain their numeric ID's progress. Failure in one repo
does not block the others; failed discovery does not use a stale list. The
original handler still checks collaborator permissions, rate limits, and
durable comment identity before enqueueing. No command gate is bypassed.

Each repository's initial boundary and subsequent cursor are stored in the
local AOF Redis database 13. Saving the initial boundary precedes the first
GitHub comment read; successful page traversal/dispatch precedes cursor
advancement. Restart resumes that cursor and catches downtime comments.
Overlapping reads may revisit a comment after restart, which the real
handler deduplicates. Redis volume removal destroys this local progress.
A renewable 30-second lease prevents concurrent installation listeners and
ownership is checked before dispatch. This is a local poll bridge; shared
GitHub App webhook/setup URLs remain unchanged.

`npm run demo:local` builds, starts/reuses the Linux worker and local Redis,
waits for worker readiness, then starts the live listener using the saved
non-secret installation ID in ignored artifacts. The website/dashboard
processes still use their separate documented startup commands. Keep this
terminal, Docker, and the PC running. This engine is not hosted and does not
run while the PC is off.

The first installation-wide startup used an explicit recovery boundary one
second before the user's command. The listener itself found comment
6332009480 and passed it through the real handler, creating
`inv_8D78C3713C1AB01B2E1B`. The worker acquired the normal concurrency lease
and began investigating source commit
`17014c5894efa91651616f8dd2fe1ba48d97f3a2`. No one-comment replay helper
was used for execution. Saved cursors exist for all three repositories and
a competing listener was rejected. This proves ingestion and execution
startup, not the eventual model investigation/fix outcome.

The listener was then stopped and restarted through the normal saved-config
launcher. The worker was reused without interruption, all three repository
cursors resumed, and exactly one investigation job remained for comment
6332009480. Evidence: ignored
`artifacts/local-audit/installation-listener-proof.json`. A second concurrent
listener was also rejected while the first owned the lease.

All 16 focused listener/command-gate tests pass. They cover all selected
repositories, additions/removals/rename, isolated failures, incomplete
discovery, restart/downtime recovery, failed checkpoint writes, exact human
commands, pagination, and unchanged role checks. Script syntax and whitespace
checks pass. This work remains local; production is deferred.
