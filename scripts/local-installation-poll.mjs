// Refresh discovery before polling: installation access defines current scope.
export async function listCompleteInstallationRepositories(listPage, maxPages = 100) {
  const repositories = [];
  for (let page = 1; page <= maxPages; page++) {
    const result = await listPage({ page, per_page: 100 });
    repositories.push(...result.repositories);
    if (result.repositories.length < 100) {
      if (Number.isSafeInteger(result.total_count) && repositories.length !== result.total_count) {
        throw new Error("Installation repository list changed during pagination; retrying discovery.");
      }
      return repositories;
    }
  }
  throw new Error("Installation repository page limit reached; refusing incomplete discovery.");
}

export function createInstallationPoller({ listRepositories, createRepoPoller, onScope = () => {}, onError = () => {} }) {
  const pollers = new Map();
  let lastScope = null;
  return async function pollInstallation() {
    const repositories = await listRepositories();
    const ids = new Set(repositories.map((repo) => String(repo.id)));
    for (const id of pollers.keys()) if (!ids.has(id)) pollers.delete(id);
    const scope = repositories.map((repo) => repo.full_name).sort().join(", ");
    if (scope !== lastScope) { await onScope(repositories); lastScope = scope; }
    for (const repository of repositories) {
      const id = String(repository.id);
      try {
        let entry = pollers.get(id);
        if (!entry || entry.name !== repository.full_name) {
          entry = { name: repository.full_name, poll: await createRepoPoller(repository) };
          pollers.set(id, entry);
        }
        await entry.poll();
      } catch (error) { onError(repository, error); }
    }
  };
}
