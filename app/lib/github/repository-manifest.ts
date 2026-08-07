import { createGitHubDocumentSourceDescriptor, documentSourceKey } from "../ingestion/document-source.js";
import { sha256 } from "../markdown/normalize.js";
import { MAX_MARKDOWN_FILE_SIZE } from "../markdown/validate-markdown.js";
import {
  parseGitHubRepositoryDescriptor,
  type GitHubRepositoryDescriptor,
  type GitHubRepositorySelection,
} from "./discovery-contracts.js";

export const GITHUB_PREVIEW_MAX_REPOSITORIES = 10;

export type GitHubTreeEntry = {
  path: string;
  type: "blob" | "tree" | "commit";
  mode: string;
  sha?: string;
  size?: number;
};

export type GitHubTreeSnapshot = {
  entries: GitHubTreeEntry[];
  truncated: boolean;
};

export const GITHUB_MANIFEST_SKIP_REASONS = [
  "out_of_scope",
  "invalid_path",
  "not_blob",
  "symbolic_link",
  "submodule",
  "invalid_size",
  "oversized",
  "invalid_blob_sha",
] as const;
export type GitHubManifestSkipReason = (typeof GITHUB_MANIFEST_SKIP_REASONS)[number];

export type GitHubManifestFile = {
  repositoryId: string;
  path: string;
  role: "readme" | "dev-plan";
  blobSha: string;
  size: number;
  sourceKey: `github:${string}:${string}`;
  rawUrl: string;
  sourceUrl: string;
};

export type GitHubRepositoryManifest = {
  repositoryId: string;
  owner: "coreline-ai";
  repositoryName: string;
  defaultBranch: string;
  commitSha: string;
  status: "ready" | "blocked";
  blockedReason?: "tree_truncated_without_fallback";
  treeStrategy: "recursive" | "contents-fallback";
  files: GitHubManifestFile[];
  skipped: Array<{ path: string; reason: GitHubManifestSkipReason }>;
  digest?: string;
};

export type CurrentGitHubDocumentState = {
  repositoryId: string;
  sourceKey: `github:${string}:${string}`;
  relativePath: string;
  blobSha: string;
};

export type GitHubDryRunAction = {
  action: "create" | "update" | "delete" | "unchanged";
  sourceKey: `github:${string}:${string}`;
  relativePath: string;
  previousBlobSha?: string;
  nextBlobSha?: string;
};

export type GitHubDryRunSummary = {
  createCount: number;
  updateCount: number;
  deleteCount: number;
  unchangedCount: number;
};

export type GitHubRepositoryDryRun = {
  repositoryId: string;
  status: "ready" | "blocked";
  blockedReason?: string;
  manifestDigest?: string;
  actions: GitHubDryRunAction[];
  summary: GitHubDryRunSummary;
};

export type GitHubFixturePreview = {
  status: "ready" | "blocked";
  selectionDigest: string;
  manifestDigest: string;
  selectedRepositoryIds: string[];
  blockedRepositoryIds: string[];
  repositories: GitHubRepositoryDryRun[];
  summary: GitHubDryRunSummary;
};

export type GitHubPreviewTotals = {
  repositories: number;
  ready: number;
  blocked: number;
  files: number;
  readme: number;
  devPlan: number;
  bytes: number;
  skipped: number;
};

export type GitHubPreviewSnapshot = {
  status: "ready" | "blocked";
  selectedRepositoryIds: string[];
  selectionDigest: string;
  manifestDigest: string;
  repositories: GitHubRepositoryManifest[];
  totals: GitHubPreviewTotals;
  generatedAt: string;
};

const gitObjectIdPattern = /^[0-9a-f]{40,64}$/i;
const repositoryIdPattern = /^[1-9][0-9]*$/;
const digestPattern = /^[0-9a-f]{64}$/i;
const regularBlobModes = new Set(["100644", "100755"]);

const emptySummary = (): GitHubDryRunSummary => ({
  createCount: 0,
  updateCount: 0,
  deleteCount: 0,
  unchangedCount: 0,
});

const normalizedRelativePath = (path: string) =>
  Boolean(path) &&
  !path.startsWith("/") &&
  !path.includes("\\") &&
  !path.split("/").some((part) => !part || part === "." || part === "..");

export function githubMarkdownRole(path: string): GitHubManifestFile["role"] | null {
  if (path === "README.md") return "readme";
  if (path.startsWith("dev-plan/") && path.endsWith(".md")) return "dev-plan";
  return null;
}

export function classifyGitHubTreeEntry(entry: GitHubTreeEntry):
  | { included: true; path: string; role: GitHubManifestFile["role"]; blobSha: string; size: number }
  | { included: false; path: string; reason: GitHubManifestSkipReason } {
  const path = String(entry.path ?? "");
  const role = githubMarkdownRole(path);
  if (!role) return { included: false, path, reason: "out_of_scope" };
  if (!normalizedRelativePath(path)) return { included: false, path, reason: "invalid_path" };
  if (entry.type === "commit" || entry.mode === "160000") {
    return { included: false, path, reason: "submodule" };
  }
  if (entry.type !== "blob") return { included: false, path, reason: "not_blob" };
  if (entry.mode === "120000") return { included: false, path, reason: "symbolic_link" };
  if (!regularBlobModes.has(entry.mode)) return { included: false, path, reason: "not_blob" };
  if (!Number.isSafeInteger(entry.size) || Number(entry.size) < 0) {
    return { included: false, path, reason: "invalid_size" };
  }
  if (Number(entry.size) > MAX_MARKDOWN_FILE_SIZE) {
    return { included: false, path, reason: "oversized" };
  }
  const blobSha = String(entry.sha ?? "").toLowerCase();
  if (!gitObjectIdPattern.test(blobSha)) {
    return { included: false, path, reason: "invalid_blob_sha" };
  }
  return { included: true, path, role, blobSha, size: Number(entry.size) };
}

const encodedPath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

export async function buildGitHubRepositoryManifest(input: {
  repository: GitHubRepositoryDescriptor;
  commitSha: string;
  recursiveTree: GitHubTreeSnapshot;
  contentsFallbackEntries?: GitHubTreeEntry[];
}): Promise<GitHubRepositoryManifest> {
  const repository = parseGitHubRepositoryDescriptor(input.repository);
  const commitSha = String(input.commitSha).toLowerCase();
  if (!gitObjectIdPattern.test(commitSha)) throw new Error("commitSha는 Git object ID여야 합니다.");

  const needsFallback = input.recursiveTree.truncated;
  const treeStrategy = needsFallback ? "contents-fallback" as const : "recursive" as const;
  if (needsFallback && !input.contentsFallbackEntries) {
    return {
      repositoryId: repository.repositoryId,
      owner: repository.owner,
      repositoryName: repository.name,
      defaultBranch: repository.defaultBranch,
      commitSha,
      status: "blocked",
      blockedReason: "tree_truncated_without_fallback",
      treeStrategy,
      files: [],
      skipped: [],
    };
  }

  const entries = needsFallback ? input.contentsFallbackEntries! : input.recursiveTree.entries;
  const files: GitHubManifestFile[] = [];
  const skipped: GitHubRepositoryManifest["skipped"] = [];
  const seenPaths = new Set<string>();
  for (const entry of entries) {
    const classified = classifyGitHubTreeEntry(entry);
    if (!classified.included) {
      if (classified.reason !== "out_of_scope") skipped.push({ path: classified.path, reason: classified.reason });
      continue;
    }
    if (seenPaths.has(classified.path)) {
      skipped.push({ path: classified.path, reason: "invalid_path" });
      continue;
    }
    seenPaths.add(classified.path);
    const sourceUrl = `https://github.com/${repository.owner}/${repository.name}/blob/${commitSha}/${encodedPath(classified.path)}`;
    const source = createGitHubDocumentSourceDescriptor({
      repositoryId: repository.repositoryId,
      repositoryOwner: repository.owner,
      repositoryName: repository.name,
      relativePath: classified.path,
      ref: repository.defaultBranch,
      commitSha,
      blobSha: classified.blobSha,
      sourceUrl,
    });
    files.push({
      repositoryId: repository.repositoryId,
      path: classified.path,
      role: classified.role,
      blobSha: classified.blobSha,
      size: classified.size,
      sourceKey: documentSourceKey(source) as GitHubManifestFile["sourceKey"],
      rawUrl: `https://raw.githubusercontent.com/${repository.owner}/${repository.name}/${commitSha}/${encodedPath(classified.path)}`,
      sourceUrl,
    });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  skipped.sort((left, right) => left.path.localeCompare(right.path) || left.reason.localeCompare(right.reason));
  const digest = await sha256(JSON.stringify({
    repositoryId: repository.repositoryId,
    commitSha,
    files: files.map(({ path, blobSha, size }) => ({ path, blobSha, size })),
  }));
  return {
    repositoryId: repository.repositoryId,
    owner: repository.owner,
    repositoryName: repository.name,
    defaultBranch: repository.defaultBranch,
    commitSha,
    status: "ready",
    treeStrategy,
    files,
    skipped,
    digest,
  };
}

const actionOrder: Record<GitHubDryRunAction["action"], number> = {
  create: 0,
  update: 1,
  delete: 2,
  unchanged: 3,
};

export function buildGitHubRepositoryDryRun(
  manifest: GitHubRepositoryManifest,
  currentDocuments: readonly CurrentGitHubDocumentState[],
): GitHubRepositoryDryRun {
  if (manifest.status === "blocked") {
    return {
      repositoryId: manifest.repositoryId,
      status: "blocked",
      blockedReason: manifest.blockedReason,
      actions: [],
      summary: emptySummary(),
    };
  }
  const current = new Map(currentDocuments
    .filter((document) => document.repositoryId === manifest.repositoryId)
    .map((document) => [document.sourceKey, document]));
  const actions: GitHubDryRunAction[] = [];
  for (const file of manifest.files) {
    const previous = current.get(file.sourceKey);
    if (!previous) {
      actions.push({
        action: "create",
        sourceKey: file.sourceKey,
        relativePath: file.path,
        nextBlobSha: file.blobSha,
      });
      continue;
    }
    actions.push({
      action: previous.blobSha.toLowerCase() === file.blobSha ? "unchanged" : "update",
      sourceKey: file.sourceKey,
      relativePath: file.path,
      previousBlobSha: previous.blobSha.toLowerCase(),
      nextBlobSha: file.blobSha,
    });
    current.delete(file.sourceKey);
  }
  for (const previous of current.values()) {
    actions.push({
      action: "delete",
      sourceKey: previous.sourceKey,
      relativePath: previous.relativePath,
      previousBlobSha: previous.blobSha.toLowerCase(),
    });
  }
  actions.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath) || actionOrder[left.action] - actionOrder[right.action]);
  const summary = emptySummary();
  for (const item of actions) summary[`${item.action}Count` as keyof GitHubDryRunSummary] += 1;
  return {
    repositoryId: manifest.repositoryId,
    status: "ready",
    manifestDigest: manifest.digest,
    actions,
    summary,
  };
}

export async function buildGitHubFixturePreview(input: {
  selection: GitHubRepositorySelection;
  manifests: readonly GitHubRepositoryManifest[];
  currentDocuments?: readonly CurrentGitHubDocumentState[];
}): Promise<GitHubFixturePreview> {
  const manifests = new Map(input.manifests.map((manifest) => [manifest.repositoryId, manifest]));
  const repositories = input.selection.selectedRepositoryIds.map((repositoryId) => {
    const manifest = manifests.get(repositoryId);
    return manifest
      ? buildGitHubRepositoryDryRun(manifest, input.currentDocuments ?? [])
      : {
        repositoryId,
        status: "blocked" as const,
        blockedReason: "manifest_missing",
        actions: [],
        summary: emptySummary(),
      };
  });
  const blockedRepositoryIds = [...new Set([
    ...input.selection.unavailableSelectedRepositoryIds,
    ...repositories.filter((item) => item.status === "blocked").map((item) => item.repositoryId),
  ])].sort((left, right) => left.localeCompare(right));
  const summary = repositories.reduce((total, item) => ({
    createCount: total.createCount + item.summary.createCount,
    updateCount: total.updateCount + item.summary.updateCount,
    deleteCount: total.deleteCount + item.summary.deleteCount,
    unchangedCount: total.unchangedCount + item.summary.unchangedCount,
  }), emptySummary());
  const manifestDigest = await sha256(JSON.stringify({
    selectionDigest: input.selection.selectionDigest,
    repositories: repositories.map((item) => ({
      repositoryId: item.repositoryId,
      status: item.status,
      blockedReason: item.blockedReason,
      manifestDigest: item.manifestDigest,
    })),
    blockedRepositoryIds,
  }));
  return {
    status: blockedRepositoryIds.length ? "blocked" : "ready",
    selectionDigest: input.selection.selectionDigest,
    manifestDigest,
    selectedRepositoryIds: [...input.selection.selectedRepositoryIds],
    blockedRepositoryIds,
    repositories,
    summary,
  };
}

const previewTotals = (repositories: readonly GitHubRepositoryManifest[]): GitHubPreviewTotals => ({
  repositories: repositories.length,
  ready: repositories.filter((repository) => repository.status === "ready").length,
  blocked: repositories.filter((repository) => repository.status === "blocked").length,
  files: repositories.reduce((total, repository) => total + repository.files.length, 0),
  readme: repositories.reduce((total, repository) =>
    total + repository.files.filter((file) => file.role === "readme").length, 0),
  devPlan: repositories.reduce((total, repository) =>
    total + repository.files.filter((file) => file.role === "dev-plan").length, 0),
  bytes: repositories.reduce((total, repository) =>
    total + repository.files.reduce((sum, file) => sum + file.size, 0), 0),
  skipped: repositories.reduce((total, repository) => total + repository.skipped.length, 0),
});

export async function buildGitHubPreviewSnapshot(input: {
  selectedRepositoryIds: readonly string[];
  repositories: readonly GitHubRepositoryManifest[];
  generatedAt?: string;
}): Promise<GitHubPreviewSnapshot> {
  const selectedRepositoryIds = [...new Set(input.selectedRepositoryIds.map(String))]
    .sort((left, right) => left.localeCompare(right));
  if (
    !selectedRepositoryIds.length
    || selectedRepositoryIds.length > GITHUB_PREVIEW_MAX_REPOSITORIES
    || selectedRepositoryIds.some((repositoryId) => !repositoryIdPattern.test(repositoryId))
  ) {
    throw new Error(`preview는 1~${GITHUB_PREVIEW_MAX_REPOSITORIES}개 숫자 repository ID가 필요합니다.`);
  }
  const repositories = [...input.repositories]
    .sort((left, right) => left.repositoryId.localeCompare(right.repositoryId));
  if (
    repositories.length !== selectedRepositoryIds.length
    || JSON.stringify(repositories.map((repository) => repository.repositoryId)) !== JSON.stringify(selectedRepositoryIds)
  ) {
    throw new Error("preview manifest와 선택 저장소가 일치하지 않습니다.");
  }
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(generatedAt))) throw new Error("preview generatedAt 형식이 잘못되었습니다.");
  const selectionDigest = await sha256(JSON.stringify({
    owner: "coreline-ai",
    selectedRepositoryIds,
  }));
  const manifestDigest = await sha256(JSON.stringify({
    selectionDigest,
    repositories: repositories.map((repository) => ({
      repositoryId: repository.repositoryId,
      commitSha: repository.commitSha,
      status: repository.status,
      digest: repository.digest,
      blockedReason: repository.blockedReason,
    })),
  }));
  const totals = previewTotals(repositories);
  return {
    status: totals.blocked ? "blocked" : "ready",
    selectedRepositoryIds,
    selectionDigest,
    manifestDigest,
    repositories,
    totals,
    generatedAt,
  };
}

const objectValue = (value: unknown) =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const exactKeys = (object: Record<string, unknown>, allowed: readonly string[], label: string) => {
  const unknown = Object.keys(object).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`${label}에 허용되지 않은 필드가 있습니다: ${unknown.join(", ")}`);
};

const safeCount = (value: unknown, label: string) => {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error(`${label}는 0 이상의 정수여야 합니다.`);
  return count;
};

function parseManifest(value: unknown): GitHubRepositoryManifest {
  const object = objectValue(value);
  if (!object) throw new Error("preview repository manifest는 객체여야 합니다.");
  exactKeys(object, [
    "repositoryId", "owner", "repositoryName", "defaultBranch", "commitSha", "status",
    "blockedReason", "treeStrategy", "files", "skipped", "digest",
  ], "preview repository manifest");
  const repositoryId = String(object.repositoryId ?? "");
  if (!repositoryIdPattern.test(repositoryId) || object.owner !== "coreline-ai") {
    throw new Error("preview repository identity가 잘못되었습니다.");
  }
  const repositoryName = String(object.repositoryName ?? "");
  if (!/^[a-zA-Z0-9._-]{1,100}$/.test(repositoryName)) throw new Error("preview repository 이름이 잘못되었습니다.");
  const defaultBranch = String(object.defaultBranch ?? "");
  if (!defaultBranch || defaultBranch.length > 255) throw new Error("preview 기본 브랜치가 잘못되었습니다.");
  const commitSha = String(object.commitSha ?? "").toLowerCase();
  if (!gitObjectIdPattern.test(commitSha)) throw new Error("preview commit SHA가 잘못되었습니다.");
  const status = String(object.status ?? "") as GitHubRepositoryManifest["status"];
  if (status !== "ready" && status !== "blocked") throw new Error("preview repository 상태가 잘못되었습니다.");
  const treeStrategy = String(object.treeStrategy ?? "") as GitHubRepositoryManifest["treeStrategy"];
  if (treeStrategy !== "recursive" && treeStrategy !== "contents-fallback") {
    throw new Error("preview treeStrategy가 잘못되었습니다.");
  }
  const blockedReason = object.blockedReason === undefined ? undefined : String(object.blockedReason);
  if (blockedReason !== undefined && blockedReason !== "tree_truncated_without_fallback") {
    throw new Error("preview blockedReason이 잘못되었습니다.");
  }
  if (!Array.isArray(object.files) || object.files.length > 2_000) {
    throw new Error("preview 파일 목록은 최대 2,000개여야 합니다.");
  }
  const files = object.files.map((value) => {
    const file = objectValue(value);
    if (!file) throw new Error("preview 파일은 객체여야 합니다.");
    exactKeys(file, ["repositoryId", "path", "role", "blobSha", "size", "sourceKey", "rawUrl", "sourceUrl"], "preview 파일");
    const path = String(file.path ?? "");
    const role = String(file.role ?? "") as GitHubManifestFile["role"];
    const blobSha = String(file.blobSha ?? "").toLowerCase();
    if (file.repositoryId !== repositoryId || !normalizedRelativePath(path) || githubMarkdownRole(path) !== role) {
      throw new Error("preview 파일 경로 또는 역할이 잘못되었습니다.");
    }
    if (!gitObjectIdPattern.test(blobSha)) throw new Error("preview Blob SHA가 잘못되었습니다.");
    const size = safeCount(file.size, "preview 파일 크기");
    if (size > MAX_MARKDOWN_FILE_SIZE) throw new Error("preview 파일 크기가 상한을 초과했습니다.");
    const expectedSourceKey = `github:${repositoryId}:${path}` as const;
    if (file.sourceKey !== expectedSourceKey) throw new Error("preview source key가 잘못되었습니다.");
    const encoded = encodedPath(path);
    const expectedSourceUrl = `https://github.com/coreline-ai/${repositoryName}/blob/${commitSha}/${encoded}`;
    const expectedRawUrl = `https://raw.githubusercontent.com/coreline-ai/${repositoryName}/${commitSha}/${encoded}`;
    if (file.sourceUrl !== expectedSourceUrl || file.rawUrl !== expectedRawUrl) {
      throw new Error("preview source URL이 잘못되었습니다.");
    }
    return {
      repositoryId,
      path,
      role,
      blobSha,
      size,
      sourceKey: expectedSourceKey,
      rawUrl: expectedRawUrl,
      sourceUrl: expectedSourceUrl,
    };
  });
  if (!Array.isArray(object.skipped) || object.skipped.length > 2_000) {
    throw new Error("preview skipped 목록은 최대 2,000개여야 합니다.");
  }
  const skipped = object.skipped.map((value) => {
    const item = objectValue(value);
    if (!item) throw new Error("preview skipped 항목은 객체여야 합니다.");
    exactKeys(item, ["path", "reason"], "preview skipped 항목");
    const reason = String(item.reason ?? "") as GitHubManifestSkipReason;
    if (!GITHUB_MANIFEST_SKIP_REASONS.includes(reason)) throw new Error("preview skip reason이 잘못되었습니다.");
    return { path: String(item.path ?? "").slice(0, 1_000), reason };
  });
  const digest = object.digest === undefined ? undefined : String(object.digest).toLowerCase();
  if (status === "ready" && (!digest || !digestPattern.test(digest))) throw new Error("preview manifest digest가 필요합니다.");
  if (status === "blocked" && files.length) throw new Error("blocked preview에는 파일을 포함할 수 없습니다.");
  return {
    repositoryId,
    owner: "coreline-ai",
    repositoryName,
    defaultBranch,
    commitSha,
    status,
    blockedReason: blockedReason as GitHubRepositoryManifest["blockedReason"],
    treeStrategy,
    files,
    skipped,
    digest,
  };
}

export function parseGitHubPreviewSnapshot(value: unknown): GitHubPreviewSnapshot {
  const object = objectValue(value);
  if (!object) throw new Error("GitHub preview snapshot은 객체여야 합니다.");
  exactKeys(object, ["status", "selectedRepositoryIds", "selectionDigest", "manifestDigest", "repositories", "totals", "generatedAt"], "GitHub preview snapshot");
  const status = String(object.status ?? "") as GitHubPreviewSnapshot["status"];
  if (status !== "ready" && status !== "blocked") throw new Error("GitHub preview 상태가 잘못되었습니다.");
  if (!Array.isArray(object.selectedRepositoryIds)) throw new Error("GitHub preview 선택 목록이 필요합니다.");
  const selectedRepositoryIds = object.selectedRepositoryIds.map(String).sort((left, right) => left.localeCompare(right));
  if (
    !selectedRepositoryIds.length
    || selectedRepositoryIds.length > GITHUB_PREVIEW_MAX_REPOSITORIES
    || selectedRepositoryIds.some((repositoryId) => !repositoryIdPattern.test(repositoryId))
    || new Set(selectedRepositoryIds).size !== selectedRepositoryIds.length
  ) throw new Error("GitHub preview 선택 목록이 잘못되었습니다.");
  if (!Array.isArray(object.repositories)) throw new Error("GitHub preview manifest 목록이 필요합니다.");
  const repositories = object.repositories.map(parseManifest)
    .sort((left, right) => left.repositoryId.localeCompare(right.repositoryId));
  if (JSON.stringify(repositories.map((repository) => repository.repositoryId)) !== JSON.stringify(selectedRepositoryIds)) {
    throw new Error("GitHub preview manifest와 선택 목록이 일치하지 않습니다.");
  }
  const selectionDigest = String(object.selectionDigest ?? "").toLowerCase();
  const manifestDigest = String(object.manifestDigest ?? "").toLowerCase();
  if (!digestPattern.test(selectionDigest) || !digestPattern.test(manifestDigest)) {
    throw new Error("GitHub preview digest 형식이 잘못되었습니다.");
  }
  const totalsObject = objectValue(object.totals);
  if (!totalsObject) throw new Error("GitHub preview totals가 필요합니다.");
  const keys = ["repositories", "ready", "blocked", "files", "readme", "devPlan", "bytes", "skipped"] as const;
  exactKeys(totalsObject, keys, "GitHub preview totals");
  const totals = Object.fromEntries(keys.map((key) => [key, safeCount(totalsObject[key], `preview totals.${key}`)])) as GitHubPreviewTotals;
  const expectedTotals = previewTotals(repositories);
  if (keys.some((key) => totals[key] !== expectedTotals[key])) throw new Error("GitHub preview totals가 manifest와 일치하지 않습니다.");
  if ((status === "blocked") !== (totals.blocked > 0)) throw new Error("GitHub preview 상태와 blocked 집계가 일치하지 않습니다.");
  const generatedAt = String(object.generatedAt ?? "");
  if (!Number.isFinite(Date.parse(generatedAt))) throw new Error("GitHub preview generatedAt 형식이 잘못되었습니다.");
  return { status, selectedRepositoryIds, selectionDigest, manifestDigest, repositories, totals, generatedAt };
}
