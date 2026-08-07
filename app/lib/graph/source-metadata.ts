import type {
  GitHubNodeSource,
  KnowledgeEdge,
  KnowledgeNode,
} from "../../graph-data";

const GITHUB_HOST = "github.com";
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40,64}$/i;
const GITHUB_IDENTITY_PATTERN = /^[a-z0-9_.-]+$/i;
const LINE_FRAGMENT_PATTERN = /^#L[1-9]\d*(?:-L[1-9]\d*)?$/;

const decodePathSegment = (value: string) => {
  try {
    const decoded = decodeURIComponent(value);
    if (!decoded || decoded === "." || decoded === ".." || /[\\/]/.test(decoded)) return null;
    return decoded;
  } catch {
    return null;
  }
};

export function parseGitHubNodeSource(
  sourceUrl: string,
  repositoryId: string,
): GitHubNodeSource | null {
  try {
    const url = new URL(sourceUrl);
    if (
      url.protocol !== "https:"
      || url.hostname.toLowerCase() !== GITHUB_HOST
      || url.port
      || url.username
      || url.password
      || url.search
      || (url.hash && !LINE_FRAGMENT_PATTERN.test(url.hash))
    ) return null;

    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 5 || parts[2] !== "blob") return null;
    const owner = decodePathSegment(parts[0]);
    const repositoryName = decodePathSegment(parts[1]);
    const commitSha = parts[3];
    const relativeSegments = parts.slice(4).map(decodePathSegment);
    if (
      !owner
      || !repositoryName
      || !GITHUB_IDENTITY_PATTERN.test(owner)
      || !GITHUB_IDENTITY_PATTERN.test(repositoryName)
      || !COMMIT_SHA_PATTERN.test(commitSha)
      || relativeSegments.some((segment) => !segment)
    ) return null;

    return {
      provider: "github",
      repositoryId,
      repositoryOwner: owner,
      repositoryName,
      relativePath: relativeSegments.join("/"),
      commitSha: commitSha.toLowerCase(),
      sourceUrl,
    };
  } catch {
    return null;
  }
}

const sourcePriority = (source: GitHubNodeSource) =>
  source.relativePath.toLowerCase() === "readme.md" ? 0 : 1;

const bySourcePriority = (left: GitHubNodeSource, right: GitHubNodeSource) =>
  sourcePriority(left) - sourcePriority(right)
  || left.relativePath.localeCompare(right.relativePath)
  || left.sourceUrl.localeCompare(right.sourceUrl);

export function attachRepositoryNodeSources(
  nodes: readonly KnowledgeNode[],
  edges: readonly KnowledgeEdge[],
  repositoryId: string,
): KnowledgeNode[] {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const candidates = new Map<string, GitHubNodeSource[]>();

  for (const edge of edges) {
    const endpointIds = [edge.source, edge.target].filter((id) => nodeIds.has(id));
    if (!endpointIds.length) continue;
    for (const evidence of edge.evidence ?? []) {
      if (!evidence.sourceUrl) continue;
      const source = parseGitHubNodeSource(evidence.sourceUrl, repositoryId);
      if (!source) continue;
      for (const endpointId of endpointIds) {
        const sources = candidates.get(endpointId) ?? [];
        sources.push(source);
        candidates.set(endpointId, sources);
      }
    }
  }

  return nodes.map((node) => {
    const source = candidates.get(node.id)?.sort(bySourcePriority)[0];
    return source ? { ...node, source } : node;
  });
}
