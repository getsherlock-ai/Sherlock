// A local development bridge, not a replacement for signed production webhooks.
// Advance the cursor only after every page and handler succeeds. Overlapping
// reads tolerate API visibility delays; the real handler also deduplicates IDs.
export function createCommandPoller({ startedAt, listPage, isCommand, handleComment,
  now = Date.now, maxPages = 10, checkpoint = null, saveCheckpoint = async () => {} }) {
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) throw new Error("Invalid listener start time.");
  let cursor = checkpoint ? Date.parse(checkpoint.cursor) : start;
  if (!Number.isFinite(cursor) || cursor < start) throw new Error("Invalid listener checkpoint.");
  const seen = new Map();
  return async function poll() {
    const pollStarted = now();
    const since = new Date(Math.max(start, cursor - 60_000)).toISOString();
    for (let page = 1; page <= maxPages; page++) {
      const comments = await listPage({ since, page, per_page: 100 });
      for (const comment of comments) {
        const created = Date.parse(comment.created_at);
        if (!Number.isFinite(created) || created < start || seen.has(comment.id)) continue;
        if (isCommand(comment)) await handleComment(comment);
        seen.set(comment.id, Date.parse(comment.updated_at) || created);
      }
      if (comments.length < 100) {
        const nextCursor = Math.max(cursor, pollStarted);
        await saveCheckpoint({ startedAt, cursor: new Date(nextCursor).toISOString() });
        cursor = nextCursor;
        for (const [id, updated] of seen) {
          if (updated < cursor - 120_000) seen.delete(id);
        }
        return;
      }
    }
    throw new Error("Comment page limit reached; cursor retained for retry.");
  };
}
