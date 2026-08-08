import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import {
  GITHUB_REPOSITORY_APPLY_MAX_BYTES,
  GITHUB_REPOSITORY_APPLY_MAX_FILES,
  type GitHubApplySubmission,
} from "../../app/lib/github/apply-contracts.js";
import {
  buildGitHubDiscoverySnapshot,
  GITHUB_SOURCE_OWNER,
  parseGitHubRepositoryDescriptor,
  type GitHubRepositoryDescriptor,
} from "../../app/lib/github/discovery-contracts.js";
import {
  buildGitHubPreviewSnapshot,
  buildGitHubRepositoryManifest,
  GITHUB_PREVIEW_MAX_REPOSITORIES,
  type GitHubPreviewSnapshot,
  type GitHubTreeEntry,
  type GitHubTreeSnapshot,
} from "../../app/lib/github/repository-manifest.js";
import type {
  GitHubRuntimeCapabilityRecord,
  GitHubSourceErrorCode,
  GitHubSourceJobRecord,
  GitHubSourceJobResult,
} from "../../app/lib/github/source-job-contracts.js";
import type { IntegratedRuntimeConfig } from "../runtime/config.js";

const execFileAsync = promisify(execFile);

type CapabilityReport = Omit<GitHubRuntimeCapabilityRecord, "runtimeId" | "lastSeenAt">;
type CommandOptions = {
  timeout: number;
  env: NodeJS.ProcessEnv;
  maxBuffer: number;
  signal?: AbortSignal;
};
export type GitHubCommandExecutor = (
  command: string,
  args: readonly string[],
  options: CommandOptions,
) => Promise<{ stdout: string; stderr: string }>;

const executeCommand: GitHubCommandExecutor = async (command, args, options) => {
  const result = await execFileAsync(command, [...args], {
    ...options,
    encoding: "utf8",
  });
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
};

export const cleanGitHubEnvironment = (): NodeJS.ProcessEnv & Record<string, string> => {
  const removed = new Set([
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
    "GH_DEBUG",
    "ATLAS_INTERNAL_RUNTIME_SECRET",
    "OPENAI_API_KEY",
    "LIGHTRAG_API_KEY",
    "CODEX_API_KEY",
  ]);
  return {
    ...Object.fromEntries(
    Object.entries(process.env).filter(([key, value]) =>
      value !== undefined && !removed.has(key) && !key.startsWith("ATLAS_RUNTIME_"),
    ),
    ),
    NODE_ENV: process.env.NODE_ENV ?? "production",
  } as NodeJS.ProcessEnv & Record<string, string>;
};

const repositoryObjectJq = [
  "{",
  "repositoryId:(.id|tostring),",
  "owner:.owner.login,",
  "name:.name,",
  "visibility:(if .private then \"private\" else (.visibility // \"public\") end),",
  "isPrivate:.private,",
  "isFork:.fork,",
  "isArchived:.archived,",
  "isTemplate:(.is_template // false),",
  "defaultBranch:.default_branch,",
  "updatedAt:.updated_at,",
  "url:.html_url",
  "}",
].join("");
const repositoryJq = `.[] | ${repositoryObjectJq}`;
const commitJq = "{commitSha:.sha,treeSha:.commit.tree.sha}";
const treeJq = "{truncated:(.truncated // false),entries:[.tree[]|select(.path==\"README.md\" or (.path|startswith(\"dev-plan/\")))|{path,type,mode,sha,size}]}";
const contentsJq = "(if type==\"array\" then . else [.] end)|[.[]|{path,type,sha,size}]";
const blobJq = "{encoding,content,size,sha}";

export class GitHubSourceEngineError extends Error {
  constructor(
    readonly code: GitHubSourceErrorCode,
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = "GitHubSourceEngineError";
  }
}

const errorText = (error: unknown) => {
  if (!error || typeof error !== "object") return "";
  const candidate = error as { code?: unknown; message?: unknown; stderr?: unknown; killed?: unknown };
  return `${String(candidate.code ?? "")} ${String(candidate.message ?? "")} ${String(candidate.stderr ?? "")}`.toLowerCase();
};

function mappedError(error: unknown): GitHubSourceEngineError {
  if (error instanceof GitHubSourceEngineError) return error;
  const text = errorText(error);
  if (text.includes("enoent") || text.includes("not found")) {
    return new GitHubSourceEngineError("gh_missing", false, "GitHub CLI(gh)를 찾을 수 없습니다.");
  }
  if (text.includes("timed out") || text.includes("timeout") || text.includes("abort")) {
    return new GitHubSourceEngineError("runtime_unavailable", true, "GitHub CLI 응답 시간이 초과되었습니다.");
  }
  if (text.includes("rate limit") || text.includes("secondary rate")) {
    return new GitHubSourceEngineError("github_rate_limited", true, "GitHub 요청 제한에 도달했습니다.");
  }
  if (text.includes("not logged") || text.includes("authenticate") || text.includes("authentication")) {
    return new GitHubSourceEngineError("gh_auth_required", false, "로컬 GitHub CLI 로그인이 필요합니다.");
  }
  if (text.includes("forbidden") || text.includes("http 403")) {
    return new GitHubSourceEngineError("github_forbidden", false, "coreline-ai 저장소를 읽을 권한이 없습니다.");
  }
  if (text.includes("http 404")) {
    return new GitHubSourceEngineError("github_forbidden", false, "선택한 저장소 또는 기본 브랜치에 접근할 수 없습니다.");
  }
  return new GitHubSourceEngineError("runtime_unavailable", true, "GitHub CLI 요청에 실패했습니다.");
}

const objectValue = (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown>
  : null;

function parseActiveAccount(value: unknown) {
  const root = objectValue(value);
  const hosts = objectValue(root?.hosts);
  const entries = Array.isArray(hosts?.["github.com"]) ? hosts["github.com"] : [];
  const active = entries.map(objectValue).find((entry) => entry?.active === true) ?? entries.map(objectValue)[0];
  return {
    login: typeof active?.login === "string" ? active.login : undefined,
    state: typeof active?.state === "string" ? active.state : undefined,
  };
}

export class GitHubSourceEngine {
  constructor(
    private readonly config: IntegratedRuntimeConfig,
    private readonly dependencies: {
      execute?: GitHubCommandExecutor;
      now?: () => string;
    } = {},
  ) {}

  private get execute() {
    return this.dependencies.execute ?? executeCommand;
  }

  private now() {
    return this.dependencies.now?.() ?? new Date().toISOString();
  }

  private command() {
    return this.config.ghPath || "gh";
  }

  private options(signal?: AbortSignal): CommandOptions {
    return {
      timeout: this.config.githubTimeoutMs,
      env: cleanGitHubEnvironment(),
      maxBuffer: 4 * 1024 * 1024,
      signal,
    };
  }

  private async apiJson(endpoint: string, jq: string, signal?: AbortSignal) {
    try {
      const { stdout } = await this.execute(
        this.command(),
        ["api", endpoint, "--method", "GET", "--jq", jq],
        this.options(signal),
      );
      return JSON.parse(stdout) as unknown;
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new GitHubSourceEngineError("invalid_result", false, "GitHub API JSON 응답 검증에 실패했습니다.");
      }
      throw mappedError(error);
    }
  }

  private async apiJsonOrNull(endpoint: string, jq: string, signal?: AbortSignal) {
    try {
      const { stdout } = await this.execute(
        this.command(),
        ["api", endpoint, "--method", "GET", "--jq", jq],
        this.options(signal),
      );
      return JSON.parse(stdout) as unknown;
    } catch (error) {
      if (errorText(error).includes("http 404")) return null;
      if (error instanceof SyntaxError) {
        throw new GitHubSourceEngineError("invalid_result", false, "GitHub API JSON 응답 검증에 실패했습니다.");
      }
      throw mappedError(error);
    }
  }

  private parseTree(value: unknown): GitHubTreeSnapshot {
    const object = objectValue(value);
    if (!object || typeof object.truncated !== "boolean" || !Array.isArray(object.entries)) {
      throw new GitHubSourceEngineError("invalid_result", false, "GitHub Tree 응답 형식이 잘못되었습니다.");
    }
    if (object.entries.length > 10_000) {
      throw new GitHubSourceEngineError("invalid_result", false, "GitHub Tree 대상 파일 수가 안전 상한을 초과했습니다.");
    }
    const entries = object.entries.map((value) => {
      const entry = objectValue(value);
      const type = String(entry?.type ?? "") as GitHubTreeEntry["type"];
      if (!entry || !["blob", "tree", "commit"].includes(type)) {
        throw new GitHubSourceEngineError("invalid_result", false, "GitHub Tree 항목 형식이 잘못되었습니다.");
      }
      const path = String(entry.path ?? "");
      if (!path || path.length > 1_000) {
        throw new GitHubSourceEngineError("invalid_result", false, "GitHub Tree path 형식이 잘못되었습니다.");
      }
      const size = entry.size === null || entry.size === undefined ? undefined : Number(entry.size);
      if (size !== undefined && (!Number.isSafeInteger(size) || size < 0)) {
        throw new GitHubSourceEngineError("invalid_result", false, "GitHub Tree size 형식이 잘못되었습니다.");
      }
      return {
        path,
        type,
        mode: String(entry.mode ?? ""),
        sha: entry.sha === null || entry.sha === undefined ? undefined : String(entry.sha),
        size,
      };
    });
    return { entries, truncated: object.truncated };
  }

  private async contentsFallback(
    repository: GitHubRepositoryDescriptor,
    commitSha: string,
    signal?: AbortSignal,
  ): Promise<GitHubTreeEntry[]> {
    const queue = ["README.md", "dev-plan"];
    const entries: GitHubTreeEntry[] = [];
    let requestCount = 0;
    while (queue.length) {
      const path = queue.shift()!;
      requestCount += 1;
      if (requestCount > 500 || entries.length > 10_000) {
        throw new GitHubSourceEngineError("invalid_result", false, "GitHub Contents fallback 안전 상한을 초과했습니다.");
      }
      const encodedPath = path.split("/").map(encodeURIComponent).join("/");
      const response = await this.apiJsonOrNull(
        `repos/${repository.owner}/${repository.name}/contents/${encodedPath}?ref=${encodeURIComponent(commitSha)}`,
        contentsJq,
        signal,
      );
      if (response === null) continue;
      if (!Array.isArray(response)) {
        throw new GitHubSourceEngineError("invalid_result", false, "GitHub Contents 응답 형식이 잘못되었습니다.");
      }
      for (const value of response) {
        const item = objectValue(value);
        if (!item) throw new GitHubSourceEngineError("invalid_result", false, "GitHub Contents 항목 형식이 잘못되었습니다.");
        const itemPath = String(item.path ?? "");
        const type = String(item.type ?? "");
        if (!itemPath || itemPath.length > 1_000) {
          throw new GitHubSourceEngineError("invalid_result", false, "GitHub Contents path 형식이 잘못되었습니다.");
        }
        if (type === "dir") {
          if (itemPath === "dev-plan" || itemPath.startsWith("dev-plan/")) queue.push(itemPath);
          continue;
        }
        const entryType: GitHubTreeEntry["type"] = type === "submodule" ? "commit" : "blob";
        const mode = type === "submodule" ? "160000" : type === "symlink" ? "120000" : "100644";
        entries.push({
          path: itemPath,
          type: entryType,
          mode,
          sha: item.sha === null || item.sha === undefined ? undefined : String(item.sha),
          size: item.size === null || item.size === undefined ? undefined : Number(item.size),
        });
      }
    }
    return entries;
  }

  private async buildPreviewSnapshot(
    selectedRepositoryIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<GitHubPreviewSnapshot> {
    const manifests = [];
    for (const repositoryId of selectedRepositoryIds) {
      const repository = parseGitHubRepositoryDescriptor(await this.apiJson(
        `repositories/${repositoryId}`,
        repositoryObjectJq,
        signal,
      ));
      const commit = objectValue(await this.apiJson(
        `repos/${repository.owner}/${repository.name}/commits/${encodeURIComponent(repository.defaultBranch)}`,
        commitJq,
        signal,
      ));
      const commitSha = String(commit?.commitSha ?? "").toLowerCase();
      const treeSha = String(commit?.treeSha ?? "").toLowerCase();
      if (!/^[0-9a-f]{40,64}$/.test(commitSha) || !/^[0-9a-f]{40,64}$/.test(treeSha)) {
        throw new GitHubSourceEngineError("invalid_result", false, "GitHub 기본 브랜치 commit 응답이 잘못되었습니다.");
      }
      const recursiveTree = this.parseTree(await this.apiJson(
        `repos/${repository.owner}/${repository.name}/git/trees/${treeSha}?recursive=1`,
        treeJq,
        signal,
      ));
      const contentsFallbackEntries = recursiveTree.truncated
        ? await this.contentsFallback(repository, commitSha, signal)
        : undefined;
      manifests.push(await buildGitHubRepositoryManifest({
        repository,
        commitSha,
        recursiveTree,
        contentsFallbackEntries,
      }));
    }
    return buildGitHubPreviewSnapshot({
      selectedRepositoryIds,
      repositories: manifests,
      generatedAt: this.now(),
    });
  }

  private async downloadBlob(input: {
    owner: string;
    repositoryName: string;
    path: string;
    blobSha: string;
    expectedSize: number;
    repositoryId: string;
    signal?: AbortSignal;
  }) {
    const blob = objectValue(await this.apiJson(
      `repos/${input.owner}/${input.repositoryName}/git/blobs/${input.blobSha}`,
      blobJq,
      input.signal,
    ));
    const encoded = String(blob?.content ?? "").replace(/\s+/g, "");
    if (
      blob?.encoding !== "base64"
      || String(blob.sha ?? "").toLowerCase() !== input.blobSha
      || Number(blob.size) !== input.expectedSize
      || !/^[a-zA-Z0-9+/]*={0,2}$/.test(encoded)
      || encoded.length % 4 !== 0
    ) {
      throw new GitHubSourceEngineError("invalid_result", false, `GitHub Blob metadata가 manifest와 다릅니다: ${input.path}`);
    }
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.byteLength !== input.expectedSize) {
      throw new GitHubSourceEngineError("invalid_result", false, `GitHub Blob 크기가 manifest와 다릅니다: ${input.path}`);
    }
    const algorithm = input.blobSha.length === 64 ? "sha256" : "sha1";
    const digest = createHash(algorithm)
      .update(`blob ${bytes.byteLength}\0`)
      .update(bytes)
      .digest("hex");
    if (digest !== input.blobSha) {
      throw new GitHubSourceEngineError("invalid_result", false, `GitHub Blob SHA가 일치하지 않습니다: ${input.path}`);
    }
    let content: string;
    try {
      // `ignoreBOM: true` keeps U+FEFF in the decoded string. The Apply contract
      // re-encodes the string to verify the exact Git Blob bytes before the
      // ingestion normalizer removes the optional Markdown BOM.
      content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new GitHubSourceEngineError("invalid_result", false, `UTF-8 Markdown만 apply할 수 있습니다: ${input.path}`);
    }
    return {
      repositoryId: input.repositoryId,
      path: input.path,
      blobSha: input.blobSha,
      size: bytes.byteLength,
      content,
    };
  }

  async checkCapability(signal?: AbortSignal): Promise<CapabilityReport> {
    const checkedAt = this.now();
    try {
      await this.execute(this.command(), ["--version"], this.options(signal));
    } catch (error) {
      const mapped = mappedError(error);
      return {
        capability: "github-source",
        status: "offline",
        errorCode: mapped.code === "gh_missing" ? "gh_missing" : "runtime_unavailable",
        host: "github.com",
        message: mapped.message,
        checkedAt,
      };
    }

    try {
      const { stdout } = await this.execute(this.command(), [
        "auth",
        "status",
        "--active",
        "--hostname",
        "github.com",
        "--json",
        "hosts",
      ], this.options(signal));
      const account = parseActiveAccount(JSON.parse(stdout));
      if (account.state !== "success" || !account.login) {
        return {
          capability: "github-source",
          status: "login_required",
          errorCode: "gh_auth_required",
          host: "github.com",
          message: "로컬 GitHub CLI 로그인이 필요합니다.",
          checkedAt,
        };
      }
      if (account.login.toLowerCase() !== GITHUB_SOURCE_OWNER) {
        return {
          capability: "github-source",
          status: "forbidden",
          errorCode: "github_forbidden",
          accountLogin: account.login,
          host: "github.com",
          message: `${GITHUB_SOURCE_OWNER} 계정 로그인이 필요합니다.`,
          checkedAt,
        };
      }
      return {
        capability: "github-source",
        status: "online",
        accountLogin: account.login,
        host: "github.com",
        message: "로컬 gh 인증으로 저장소 discovery를 사용할 수 있습니다.",
        checkedAt,
      };
    } catch (error) {
      const mapped = mappedError(error);
      const status = mapped.code === "gh_auth_required" ? "login_required"
        : mapped.code === "github_forbidden" ? "forbidden"
          : mapped.code === "github_rate_limited" ? "rate_limited"
            : "offline";
      return {
        capability: "github-source",
        status,
        errorCode: mapped.code,
        host: "github.com",
        message: mapped.message,
        checkedAt,
      };
    }
  }

  async discover(job: GitHubSourceJobRecord, signal?: AbortSignal): Promise<GitHubSourceJobResult> {
    if (job.kind !== "discovery") {
      throw new GitHubSourceEngineError("invalid_input", false, "현재 단계에서는 discovery 작업만 지원합니다.");
    }
    const capability = await this.checkCapability(signal);
    if (capability.status !== "online" || !capability.accountLogin) {
      throw new GitHubSourceEngineError(
        capability.errorCode ?? "runtime_unavailable",
        capability.status === "offline" || capability.status === "rate_limited",
        capability.message ?? "GitHub source capability를 사용할 수 없습니다.",
      );
    }

    let stdout: string;
    try {
      ({ stdout } = await this.execute(this.command(), [
        "api",
        "--paginate",
        "user/repos?per_page=100&affiliation=owner&visibility=all",
        "--method",
        "GET",
        "--jq",
        repositoryJq,
      ], this.options(signal)));
    } catch (error) {
      throw mappedError(error);
    }

    let repositories: GitHubRepositoryDescriptor[];
    try {
      repositories = stdout.split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => parseGitHubRepositoryDescriptor(JSON.parse(line)));
    } catch {
      throw new GitHubSourceEngineError("invalid_result", false, "GitHub 저장소 목록 형식 검증에 실패했습니다.");
    }
    const discovery = await buildGitHubDiscoverySnapshot(
      repositories,
      capability.accountLogin,
      this.now(),
    );
    return {
      jobId: job.id,
      idempotencyKey: job.idempotencyKey,
      kind: job.kind,
      status: "completed",
      capability,
      summary: {
        discoveredCount: discovery.totals.total,
        selectedCount: discovery.totals.selected,
        changedCount: 0,
        unchangedCount: 0,
        deletedCount: 0,
        failedCount: 0,
      },
      discovery,
    };
  }

  async preview(job: GitHubSourceJobRecord, signal?: AbortSignal): Promise<GitHubSourceJobResult> {
    if (
      job.kind !== "preview"
      || !job.input.selectedRepositoryIds.length
      || job.input.selectedRepositoryIds.length > GITHUB_PREVIEW_MAX_REPOSITORIES
    ) {
      throw new GitHubSourceEngineError(
        "invalid_input",
        false,
        `preview는 1~${GITHUB_PREVIEW_MAX_REPOSITORIES}개의 선택 저장소가 필요합니다.`,
      );
    }
    const capability = await this.checkCapability(signal);
    if (capability.status !== "online" || !capability.accountLogin) {
      throw new GitHubSourceEngineError(
        capability.errorCode ?? "runtime_unavailable",
        capability.status === "offline" || capability.status === "rate_limited",
        capability.message ?? "GitHub source capability를 사용할 수 없습니다.",
      );
    }

    const preview = await this.buildPreviewSnapshot(job.input.selectedRepositoryIds, signal);
    return {
      jobId: job.id,
      idempotencyKey: job.idempotencyKey,
      kind: job.kind,
      status: "completed",
      capability,
      summary: {
        discoveredCount: preview.totals.repositories,
        selectedCount: preview.totals.repositories,
        changedCount: 0,
        unchangedCount: 0,
        deletedCount: 0,
        failedCount: preview.totals.blocked,
      },
      preview,
    };
  }

  async apply(job: GitHubSourceJobRecord, signal?: AbortSignal): Promise<GitHubApplySubmission> {
    if (
      job.kind !== "apply"
      || job.input.selectedRepositoryIds.length !== 1
      || !job.input.manifestDigest
    ) {
      throw new GitHubSourceEngineError("invalid_input", false, "P4-A apply는 승인된 저장소 1개가 필요합니다.");
    }
    const capability = await this.checkCapability(signal);
    if (capability.status !== "online") {
      throw new GitHubSourceEngineError(
        capability.errorCode ?? "runtime_unavailable",
        capability.status === "offline" || capability.status === "rate_limited",
        capability.message ?? "GitHub source capability를 사용할 수 없습니다.",
      );
    }
    const preview = await this.buildPreviewSnapshot(job.input.selectedRepositoryIds, signal);
    if (preview.status !== "ready" || preview.manifestDigest !== job.input.manifestDigest) {
      throw new GitHubSourceEngineError("invalid_input", false, "preview 이후 manifest가 변경되었습니다. 다시 미리보기해야 합니다.");
    }
    const manifest = preview.repositories[0];
    if (
      manifest.files.length > GITHUB_REPOSITORY_APPLY_MAX_FILES
      || manifest.files.reduce((total, file) => total + file.size, 0) > GITHUB_REPOSITORY_APPLY_MAX_BYTES
    ) {
      throw new GitHubSourceEngineError("invalid_input", false, "저장소 파일 또는 용량 안전 상한을 초과했습니다.");
    }
    const reusableDocuments = [...(job.input.reusableDocuments ?? [])]
      .sort((left, right) => left.path.localeCompare(right.path));
    const reusableByPath = new Map(reusableDocuments.map((document) => [document.path, document]));
    if (reusableByPath.size !== reusableDocuments.length) {
      throw new GitHubSourceEngineError("invalid_input", false, "서버 reusable Blob 계획이 중복되었습니다.");
    }
    for (const reusable of reusableDocuments) {
      const file = manifest.files.find((candidate) => candidate.path === reusable.path);
      if (
        reusable.repositoryId !== manifest.repositoryId
        || !file
        || reusable.blobSha !== file.blobSha
        || reusable.size !== file.size
      ) throw new GitHubSourceEngineError("invalid_input", false, `서버 reusable Blob 계획이 최신 manifest와 다릅니다: ${reusable.path}`);
    }
    const documents = [];
    for (const file of manifest.files) {
      if (reusableByPath.has(file.path)) continue;
      documents.push(await this.downloadBlob({
        owner: manifest.owner,
        repositoryName: manifest.repositoryName,
        path: file.path,
        blobSha: file.blobSha,
        expectedSize: file.size,
        repositoryId: manifest.repositoryId,
        signal,
      }));
    }
    return {
      jobId: job.id,
      idempotencyKey: job.idempotencyKey,
      kind: "apply",
      status: "completed",
      capability,
      summary: {
        discoveredCount: 1,
        selectedCount: 1,
        changedCount: documents.length,
        unchangedCount: reusableDocuments.length,
        deletedCount: 0,
        failedCount: 0,
      },
      applyPayload: { preview, documents, reusedDocuments: reusableDocuments, downloadedAt: this.now() },
    };
  }

  async executeJob(job: GitHubSourceJobRecord, signal?: AbortSignal) {
    if (job.kind === "discovery") return this.discover(job, signal);
    if (job.kind === "preview") return this.preview(job, signal);
    if (job.kind === "apply") return this.apply(job, signal);
    throw new GitHubSourceEngineError("invalid_input", false, "지원하지 않는 GitHub source 작업입니다.");
  }
}
