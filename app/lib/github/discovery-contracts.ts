import { sha256 } from "../markdown/normalize.js";

export const GITHUB_SOURCE_OWNER = "coreline-ai" as const;
export const GITHUB_DISCOVERY_PAGE_SIZE = 100;
export const GITHUB_DISCOVERY_MAX_PAGES = 100;

export const GITHUB_REPOSITORY_VISIBILITIES = ["public", "private", "internal"] as const;
export type GitHubRepositoryVisibility = (typeof GITHUB_REPOSITORY_VISIBILITIES)[number];

export type GitHubRepositoryDescriptor = {
  repositoryId: string;
  owner: typeof GITHUB_SOURCE_OWNER;
  name: string;
  visibility: GitHubRepositoryVisibility;
  isPrivate: boolean;
  isFork: boolean;
  isArchived: boolean;
  isTemplate: boolean;
  defaultBranch: string;
  updatedAt: string;
  url: string;
};

export type GitHubRepositoryPage = {
  repositories: GitHubRepositoryDescriptor[];
  hasNextPage: boolean;
  endCursor?: string;
};

export type GitHubDiscoveryPageRequest = {
  owner: typeof GITHUB_SOURCE_OWNER;
  pageSize: number;
  cursor?: string;
};

export type GitHubRepositorySelectionItem = {
  repositoryId: string;
  syncEnabled: boolean;
  recommended: boolean;
  warning?: "test-like-name";
};

export type GitHubRepositorySelection = {
  items: GitHubRepositorySelectionItem[];
  selectedRepositoryIds: string[];
  unavailableSelectedRepositoryIds: string[];
  selectionDigest: string;
};

export type GitHubDiscoveryTotals = {
  total: number;
  public: number;
  private: number;
  internal: number;
  fork: number;
  archived: number;
  template: number;
  recommended: number;
  selected: number;
  warnings: number;
};

export type GitHubDiscoverySnapshot = {
  owner: typeof GITHUB_SOURCE_OWNER;
  accountLogin: string;
  repositories: GitHubRepositoryDescriptor[];
  selection: GitHubRepositorySelection;
  totals: GitHubDiscoveryTotals;
  generatedAt: string;
};

export class GitHubDiscoveryContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubDiscoveryContractError";
  }
}

const repositoryIdPattern = /^[1-9][0-9]*$/;
const repositoryNamePattern = /^[a-zA-Z0-9._-]{1,100}$/;
const branchPattern = /^[^\u0000-\u001f\u007f~^:?*[\\]{1,255}$/;
const cursorPattern = /^[a-zA-Z0-9._:+/=-]{1,500}$/;
const accountPattern = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})$/;
const digestPattern = /^[0-9a-f]{64}$/i;
const testLikeNamePattern = /(?:^|[-_.])(test|tests|demo|sandbox|playground|experiment|experimental|poc)(?:$|[-_.])/i;

const objectValue = (value: unknown) =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

function requireExactKeys(object: Record<string, unknown>, allowed: readonly string[], label: string) {
  const unknown = Object.keys(object).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    throw new GitHubDiscoveryContractError(`${label}에 허용되지 않은 필드가 있습니다: ${unknown.join(", ")}`);
  }
}

function parseBoolean(value: unknown, field: string) {
  if (typeof value !== "boolean") {
    throw new GitHubDiscoveryContractError(`${field}는 boolean이어야 합니다.`);
  }
  return value;
}

function parseRepositoryUrl(value: unknown, name: string) {
  let url: URL;
  try {
    url = new URL(String(value ?? ""));
  } catch {
    throw new GitHubDiscoveryContractError("GitHub 저장소 URL 형식이 잘못되었습니다.");
  }
  const expectedPath = `/${GITHUB_SOURCE_OWNER}/${name}`.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.pathname.replace(/\/+$/, "").toLowerCase() !== expectedPath ||
    url.username ||
    url.password
  ) {
    throw new GitHubDiscoveryContractError("허용된 owner의 GitHub 저장소 URL이 아닙니다.");
  }
  return `https://github.com/${GITHUB_SOURCE_OWNER}/${name}`;
}

export function parseGitHubRepositoryDescriptor(value: unknown): GitHubRepositoryDescriptor {
  const object = objectValue(value);
  if (!object) throw new GitHubDiscoveryContractError("GitHub 저장소 항목은 객체여야 합니다.");
  requireExactKeys(object, [
    "repositoryId",
    "owner",
    "name",
    "visibility",
    "isPrivate",
    "isFork",
    "isArchived",
    "isTemplate",
    "defaultBranch",
    "updatedAt",
    "url",
  ], "GitHub 저장소 항목");

  const repositoryId = String(object.repositoryId ?? "");
  if (!repositoryIdPattern.test(repositoryId)) {
    throw new GitHubDiscoveryContractError("repositoryId는 0이 아닌 숫자 문자열이어야 합니다.");
  }
  if (object.owner !== GITHUB_SOURCE_OWNER) {
    throw new GitHubDiscoveryContractError(`GitHub owner는 ${GITHUB_SOURCE_OWNER}만 허용됩니다.`);
  }
  const name = String(object.name ?? "");
  if (!repositoryNamePattern.test(name)) {
    throw new GitHubDiscoveryContractError("GitHub 저장소 이름 형식이 잘못되었습니다.");
  }
  const visibility = String(object.visibility ?? "") as GitHubRepositoryVisibility;
  if (!GITHUB_REPOSITORY_VISIBILITIES.includes(visibility)) {
    throw new GitHubDiscoveryContractError("GitHub 저장소 visibility가 잘못되었습니다.");
  }
  const isPrivate = parseBoolean(object.isPrivate, "isPrivate");
  if ((visibility === "private") !== isPrivate) {
    throw new GitHubDiscoveryContractError("visibility와 isPrivate 값이 일치하지 않습니다.");
  }
  const defaultBranch = String(object.defaultBranch ?? "");
  if (!branchPattern.test(defaultBranch) || defaultBranch.startsWith("/") || defaultBranch.endsWith("/")) {
    throw new GitHubDiscoveryContractError("GitHub 기본 브랜치 형식이 잘못되었습니다.");
  }
  const updatedAt = String(object.updatedAt ?? "");
  if (!Number.isFinite(Date.parse(updatedAt))) {
    throw new GitHubDiscoveryContractError("GitHub 저장소 updatedAt 형식이 잘못되었습니다.");
  }

  return {
    repositoryId,
    owner: GITHUB_SOURCE_OWNER,
    name,
    visibility,
    isPrivate,
    isFork: parseBoolean(object.isFork, "isFork"),
    isArchived: parseBoolean(object.isArchived, "isArchived"),
    isTemplate: parseBoolean(object.isTemplate, "isTemplate"),
    defaultBranch,
    updatedAt,
    url: parseRepositoryUrl(object.url, name),
  };
}

export function parseGitHubRepositoryPage(
  value: unknown,
  pageSize = GITHUB_DISCOVERY_PAGE_SIZE,
): GitHubRepositoryPage {
  const object = objectValue(value);
  if (!object) throw new GitHubDiscoveryContractError("GitHub discovery page는 객체여야 합니다.");
  requireExactKeys(object, ["repositories", "hasNextPage", "endCursor"], "GitHub discovery page");
  if (!Array.isArray(object.repositories) || object.repositories.length > pageSize) {
    throw new GitHubDiscoveryContractError(`GitHub discovery page는 최대 ${pageSize}개 저장소만 포함할 수 있습니다.`);
  }
  const hasNextPage = parseBoolean(object.hasNextPage, "hasNextPage");
  const endCursor = object.endCursor === undefined ? undefined : String(object.endCursor);
  if (hasNextPage && (!endCursor || !cursorPattern.test(endCursor))) {
    throw new GitHubDiscoveryContractError("다음 discovery page cursor가 필요합니다.");
  }
  return {
    repositories: object.repositories.map(parseGitHubRepositoryDescriptor),
    hasNextPage,
    endCursor,
  };
}

export async function collectGitHubRepositoryPages(
  loadPage: (request: GitHubDiscoveryPageRequest) => Promise<unknown>,
  options: { pageSize?: number; maxPages?: number } = {},
) {
  const pageSize = Math.min(100, Math.max(1, options.pageSize ?? GITHUB_DISCOVERY_PAGE_SIZE));
  const maxPages = Math.min(100, Math.max(1, options.maxPages ?? GITHUB_DISCOVERY_MAX_PAGES));
  const repositories = new Map<string, GitHubRepositoryDescriptor>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let pageCount = 0;

  while (pageCount < maxPages) {
    const page = parseGitHubRepositoryPage(await loadPage({
      owner: GITHUB_SOURCE_OWNER,
      pageSize,
      cursor,
    }), pageSize);
    pageCount += 1;
    for (const repository of page.repositories) {
      if (repositories.has(repository.repositoryId)) {
        throw new GitHubDiscoveryContractError(`중복 repositoryId가 발견되었습니다: ${repository.repositoryId}`);
      }
      repositories.set(repository.repositoryId, repository);
    }
    if (!page.hasNextPage) {
      return {
        owner: GITHUB_SOURCE_OWNER,
        repositories: [...repositories.values()].sort((left, right) =>
          left.name.localeCompare(right.name) || left.repositoryId.localeCompare(right.repositoryId)),
        pageCount,
      };
    }
    if (!page.endCursor || seenCursors.has(page.endCursor)) {
      throw new GitHubDiscoveryContractError("GitHub discovery cursor가 반복되었습니다.");
    }
    seenCursors.add(page.endCursor);
    cursor = page.endCursor;
  }
  throw new GitHubDiscoveryContractError(`GitHub discovery page가 최대 ${maxPages}개를 초과했습니다.`);
}

export const isRecommendedGitHubRepository = (repository: GitHubRepositoryDescriptor) =>
  repository.owner === GITHUB_SOURCE_OWNER && !repository.isArchived && !repository.isFork;

export const githubRepositoryWarning = (repository: GitHubRepositoryDescriptor) =>
  testLikeNamePattern.test(repository.name) ? "test-like-name" as const : undefined;

export async function resolveGitHubRepositorySelection(
  repositories: readonly GitHubRepositoryDescriptor[],
  overrides: Readonly<Record<string, boolean>> = {},
): Promise<GitHubRepositorySelection> {
  const visibleIds = new Set(repositories.map((repository) => repository.repositoryId));
  const items = repositories
    .map((repository) => {
      const recommended = isRecommendedGitHubRepository(repository);
      return {
        repositoryId: repository.repositoryId,
        syncEnabled: Object.hasOwn(overrides, repository.repositoryId)
          ? overrides[repository.repositoryId]
          : recommended,
        recommended,
        warning: githubRepositoryWarning(repository),
      };
    })
    .sort((left, right) => left.repositoryId.localeCompare(right.repositoryId));
  const selectedRepositoryIds = items
    .filter((item) => item.syncEnabled)
    .map((item) => item.repositoryId);
  const unavailableSelectedRepositoryIds = Object.entries(overrides)
    .filter(([repositoryId, selected]) => selected && !visibleIds.has(repositoryId))
    .map(([repositoryId]) => repositoryId)
    .sort((left, right) => left.localeCompare(right));
  const selectionDigest = await sha256(JSON.stringify({
    owner: GITHUB_SOURCE_OWNER,
    selectedRepositoryIds,
    unavailableSelectedRepositoryIds,
  }));
  return { items, selectedRepositoryIds, unavailableSelectedRepositoryIds, selectionDigest };
}

function discoveryTotals(
  repositories: readonly GitHubRepositoryDescriptor[],
  selection: GitHubRepositorySelection,
): GitHubDiscoveryTotals {
  return {
    total: repositories.length,
    public: repositories.filter((repository) => repository.visibility === "public").length,
    private: repositories.filter((repository) => repository.visibility === "private").length,
    internal: repositories.filter((repository) => repository.visibility === "internal").length,
    fork: repositories.filter((repository) => repository.isFork).length,
    archived: repositories.filter((repository) => repository.isArchived).length,
    template: repositories.filter((repository) => repository.isTemplate).length,
    recommended: selection.items.filter((item) => item.recommended).length,
    selected: selection.selectedRepositoryIds.length,
    warnings: selection.items.filter((item) => item.warning).length,
  };
}

export async function buildGitHubDiscoverySnapshot(
  repositories: readonly GitHubRepositoryDescriptor[],
  accountLogin: string,
  generatedAt = new Date().toISOString(),
): Promise<GitHubDiscoverySnapshot> {
  if (!accountPattern.test(accountLogin)) {
    throw new GitHubDiscoveryContractError("GitHub discovery accountLogin 형식이 잘못되었습니다.");
  }
  if (!Number.isFinite(Date.parse(generatedAt))) {
    throw new GitHubDiscoveryContractError("GitHub discovery generatedAt 형식이 잘못되었습니다.");
  }
  const normalized = repositories
    .map(parseGitHubRepositoryDescriptor)
    .sort((left, right) => left.name.localeCompare(right.name) || left.repositoryId.localeCompare(right.repositoryId));
  if (new Set(normalized.map((repository) => repository.repositoryId)).size !== normalized.length) {
    throw new GitHubDiscoveryContractError("GitHub discovery에 중복 repositoryId가 있습니다.");
  }
  const selection = await resolveGitHubRepositorySelection(normalized);
  return {
    owner: GITHUB_SOURCE_OWNER,
    accountLogin,
    repositories: normalized,
    selection,
    totals: discoveryTotals(normalized, selection),
    generatedAt,
  };
}

const parseCount = (value: unknown, field: string) => {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new GitHubDiscoveryContractError(`${field}는 0 이상의 정수여야 합니다.`);
  }
  return count;
};

export function parseGitHubDiscoverySnapshot(value: unknown): GitHubDiscoverySnapshot {
  const object = objectValue(value);
  if (!object) throw new GitHubDiscoveryContractError("GitHub discovery snapshot은 객체여야 합니다.");
  requireExactKeys(object, ["owner", "accountLogin", "repositories", "selection", "totals", "generatedAt"], "GitHub discovery snapshot");
  if (object.owner !== GITHUB_SOURCE_OWNER) {
    throw new GitHubDiscoveryContractError(`GitHub owner는 ${GITHUB_SOURCE_OWNER}만 허용됩니다.`);
  }
  const accountLogin = String(object.accountLogin ?? "");
  if (!accountPattern.test(accountLogin)) {
    throw new GitHubDiscoveryContractError("GitHub discovery accountLogin 형식이 잘못되었습니다.");
  }
  if (!Array.isArray(object.repositories) || object.repositories.length > 500) {
    throw new GitHubDiscoveryContractError("GitHub discovery repositories는 최대 500개여야 합니다.");
  }
  const repositories = object.repositories.map(parseGitHubRepositoryDescriptor);
  if (new Set(repositories.map((repository) => repository.repositoryId)).size !== repositories.length) {
    throw new GitHubDiscoveryContractError("GitHub discovery에 중복 repositoryId가 있습니다.");
  }
  const repositoryIds = new Set(repositories.map((repository) => repository.repositoryId));

  const selectionObject = objectValue(object.selection);
  if (!selectionObject) throw new GitHubDiscoveryContractError("GitHub discovery selection이 필요합니다.");
  requireExactKeys(selectionObject, ["items", "selectedRepositoryIds", "unavailableSelectedRepositoryIds", "selectionDigest"], "GitHub discovery selection");
  if (!Array.isArray(selectionObject.items) || !Array.isArray(selectionObject.selectedRepositoryIds) || !Array.isArray(selectionObject.unavailableSelectedRepositoryIds)) {
    throw new GitHubDiscoveryContractError("GitHub discovery selection 배열 형식이 잘못되었습니다.");
  }
  const items = selectionObject.items.map((entry) => {
    const item = objectValue(entry);
    if (!item) throw new GitHubDiscoveryContractError("GitHub discovery selection 항목은 객체여야 합니다.");
    requireExactKeys(item, ["repositoryId", "syncEnabled", "recommended", "warning"], "GitHub discovery selection 항목");
    const repositoryId = String(item.repositoryId ?? "");
    if (!repositoryIds.has(repositoryId)) {
      throw new GitHubDiscoveryContractError("GitHub discovery selection이 알 수 없는 저장소를 참조합니다.");
    }
    const warning = item.warning === undefined ? undefined : String(item.warning);
    if (warning !== undefined && warning !== "test-like-name") {
      throw new GitHubDiscoveryContractError("GitHub discovery selection warning이 잘못되었습니다.");
    }
    return {
      repositoryId,
      syncEnabled: parseBoolean(item.syncEnabled, "syncEnabled"),
      recommended: parseBoolean(item.recommended, "recommended"),
      warning: warning as "test-like-name" | undefined,
    };
  });
  if (items.length !== repositories.length || new Set(items.map((item) => item.repositoryId)).size !== items.length) {
    throw new GitHubDiscoveryContractError("GitHub discovery selection 항목 수가 저장소와 일치하지 않습니다.");
  }
  const parseSelectionIds = (entries: unknown[], label: string) => entries.map((entry) => {
    const repositoryId = String(entry);
    if (!repositoryIdPattern.test(repositoryId)) {
      throw new GitHubDiscoveryContractError(`${label}에 잘못된 repositoryId가 있습니다.`);
    }
    return repositoryId;
  });
  const selectedRepositoryIds = parseSelectionIds(selectionObject.selectedRepositoryIds, "selectedRepositoryIds");
  if (selectedRepositoryIds.some((repositoryId) => !repositoryIds.has(repositoryId))) {
    throw new GitHubDiscoveryContractError("selectedRepositoryIds가 알 수 없는 저장소를 참조합니다.");
  }
  const expectedSelected = items.filter((item) => item.syncEnabled).map((item) => item.repositoryId).sort();
  if (JSON.stringify([...selectedRepositoryIds].sort()) !== JSON.stringify(expectedSelected)) {
    throw new GitHubDiscoveryContractError("selection items와 selectedRepositoryIds가 일치하지 않습니다.");
  }
  const unavailableSelectedRepositoryIds = parseSelectionIds(
    selectionObject.unavailableSelectedRepositoryIds,
    "unavailableSelectedRepositoryIds",
  );
  const selectionDigest = String(selectionObject.selectionDigest ?? "").toLowerCase();
  if (!digestPattern.test(selectionDigest)) {
    throw new GitHubDiscoveryContractError("GitHub discovery selectionDigest 형식이 잘못되었습니다.");
  }
  const selection: GitHubRepositorySelection = {
    items,
    selectedRepositoryIds,
    unavailableSelectedRepositoryIds,
    selectionDigest,
  };

  const totalsObject = objectValue(object.totals);
  if (!totalsObject) throw new GitHubDiscoveryContractError("GitHub discovery totals가 필요합니다.");
  const totalKeys = ["total", "public", "private", "internal", "fork", "archived", "template", "recommended", "selected", "warnings"] as const;
  requireExactKeys(totalsObject, totalKeys, "GitHub discovery totals");
  const totals = Object.fromEntries(totalKeys.map((key) => [key, parseCount(totalsObject[key], `totals.${key}`)])) as GitHubDiscoveryTotals;
  const expectedTotals = discoveryTotals(repositories, selection);
  if (totalKeys.some((key) => totals[key] !== expectedTotals[key])) {
    throw new GitHubDiscoveryContractError("GitHub discovery totals가 저장소 집계와 일치하지 않습니다.");
  }

  const generatedAt = String(object.generatedAt ?? "");
  if (!Number.isFinite(Date.parse(generatedAt))) {
    throw new GitHubDiscoveryContractError("GitHub discovery generatedAt 형식이 잘못되었습니다.");
  }
  return { owner: GITHUB_SOURCE_OWNER, accountLogin, repositories, selection, totals, generatedAt };
}
