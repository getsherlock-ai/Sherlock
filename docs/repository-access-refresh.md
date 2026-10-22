# Local repository-access refresh

GitHub's saved selection for installation 148577457 contained
`Htetty/Demo_Broken_Repo`, `Htetty/Test-Repo-Shoplite`, and
`Htetty/Test-Repo-RecipeBox`. Sherlock's stored projection still marked the
first two removed. The screenshot's update return URL targeted the
unavailable hosted API; neither that callback nor hosted lifecycle webhooks
had reconciled the local dashboard's stored repository list.

The protected `POST /api/installations/refresh` endpoint now reads only the
signed-in user's existing installation memberships. It verifies each known
installation through the App API, fetches its complete authorized repository
list, and reconciles that snapshot. It accepts only an empty object, never
caller-supplied installation/repository IDs, and creates no memberships or
GitHub permissions. Failed GitHub reads preserve the old stored snapshot;
suspension hides the installation. Repository pagination overflow is rejected
instead of treating a partial list as authoritative removals.

The sidebar awaits refresh before reading repositories on startup and when
the visible browser tab regains focus. Concurrent focus/visibility refreshes
are coalesced. Both manage-access links open a separate GitHub tab, preserving
the local dashboard while the hosted return URL remains unavailable. The
shared GitHub App settings were not changed.

The new sidebar regression fails before the repair. Afterward, all 46
frontend tests pass. The backend's 38 focused dashboard/installation/lifecycle
checks and 27 setup-callback checks pass. Backend build, frontend typecheck,
and both whitespace checks pass. The signed-in browser now displays all
three repositories and successfully loads Shoplite's real issues. Original
uploaded artifacts and unrelated local changes are preserved.

The listener was subsequently extended to the saved installation's complete
authorized repository selection after a command on Demo_Broken_Repo #120
exposed the mismatch with the dashboard. See
[local command ingestion](local-command-ingestion.md). Production
callback/webhook repair remains deferred.
