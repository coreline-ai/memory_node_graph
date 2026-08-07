export function createGitHubRepositoryFixture(count = 137) {
  return Array.from({ length: count }, (_, offset) => {
    const index = offset + 1;
    const name = index === 5
      ? "knowledge-demo"
      : `atlas-repository-${String(index).padStart(3, "0")}`;
    const visibility = index % 4 === 0 ? "private" : "public";
    return {
      repositoryId: String(800_000 + index),
      owner: "coreline-ai",
      name,
      visibility,
      isPrivate: visibility === "private",
      isFork: index % 29 === 0,
      isArchived: index % 31 === 0,
      isTemplate: index % 17 === 0,
      defaultBranch: index % 9 === 0 ? "develop" : "main",
      updatedAt: new Date(Date.UTC(2026, 6, 1, 0, index)).toISOString(),
      url: `https://github.com/coreline-ai/${name}`,
    };
  });
}

export function createPagedGitHubFixtureLoader(repositories) {
  const requests = [];
  return {
    requests,
    async loadPage({ owner, pageSize, cursor }) {
      requests.push({ owner, pageSize, cursor });
      const start = cursor ? Number(cursor) : 0;
      const end = Math.min(repositories.length, start + pageSize);
      return {
        repositories: repositories.slice(start, end),
        hasNextPage: end < repositories.length,
        endCursor: end < repositories.length ? String(end) : undefined,
      };
    },
  };
}

export const manifestTreeFixture = Object.freeze({
  recursiveTree: {
    truncated: true,
    entries: [],
  },
  contentsFallbackEntries: [
    { path: "README.md", type: "blob", mode: "100644", sha: "b".repeat(40), size: 1_024 },
    { path: "readme.md", type: "blob", mode: "100644", sha: "c".repeat(40), size: 512 },
    { path: "docs/guide.md", type: "blob", mode: "100644", sha: "d".repeat(40), size: 512 },
    { path: "dev-plan/phase-1.md", type: "blob", mode: "100644", sha: "c".repeat(40), size: 2_048 },
    { path: "dev-plan/archive/phase-0.md", type: "blob", mode: "100755", sha: "d".repeat(40), size: 0 },
    { path: "dev-plan/uppercase.MD", type: "blob", mode: "100644", sha: "e".repeat(40), size: 100 },
    { path: "dev-plan/too-large.md", type: "blob", mode: "100644", sha: "e".repeat(40), size: 2 * 1024 * 1024 + 1 },
    { path: "dev-plan/link.md", type: "blob", mode: "120000", sha: "e".repeat(40), size: 12 },
    { path: "dev-plan/submodule.md", type: "commit", mode: "160000", sha: "e".repeat(40), size: 0 },
    { path: "dev-plan/../escape.md", type: "blob", mode: "100644", sha: "e".repeat(40), size: 12 },
    { path: "dev-plan/missing-sha.md", type: "blob", mode: "100644", size: 12 },
  ],
});
