import { validateDecodedMarkdown } from "../markdown/validate-markdown.js";
import {
  GitHubSourceContractError,
  parseGitHubCapabilityReport,
  assertCredentialFreePayload,
  type GitHubReusableDocument,
  type GitHubSourceJobRecord,
} from "./source-job-contracts.js";
import { parseGitHubPreviewSnapshot, type GitHubPreviewSnapshot } from "./repository-manifest.js";

export const GITHUB_REPOSITORY_APPLY_MAX_FILES = 500;
export const GITHUB_REPOSITORY_APPLY_MAX_BYTES = 8 * 1024 * 1024;

export type GitHubApplyDocumentPayload = {
  repositoryId: string;
  path: string;
  blobSha: string;
  size: number;
  content: string;
};

export type GitHubApplyPayload = {
  preview: GitHubPreviewSnapshot;
  documents: GitHubApplyDocumentPayload[];
  reusedDocuments: GitHubReusableDocument[];
  downloadedAt: string;
};

export type GitHubApplySubmission = {
  jobId: string;
  idempotencyKey: string;
  kind: "apply";
  status: "completed";
  capability: ReturnType<typeof parseGitHubCapabilityReport>;
  summary: {
    discoveredCount: number;
    selectedCount: number;
    changedCount: number;
    unchangedCount: number;
    deletedCount: number;
    failedCount: number;
  };
  applyPayload: GitHubApplyPayload;
};

const objectValue = (value: unknown) =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const exactKeys = (object: Record<string, unknown>, allowed: readonly string[], label: string) => {
  const unknown = Object.keys(object).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new GitHubSourceContractError(`${label}에 허용되지 않은 필드가 있습니다: ${unknown.join(", ")}`);
};

const safeCount = (value: unknown, label: string) => {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) throw new GitHubSourceContractError(`${label}는 0 이상의 정수여야 합니다.`);
  return count;
};

const gitBlobDigest = async (content: string, objectIdLength: number) => {
  const bytes = new TextEncoder().encode(content);
  const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  const object = new Uint8Array(header.byteLength + bytes.byteLength);
  object.set(header);
  object.set(bytes, header.byteLength);
  const algorithm = objectIdLength === 64 ? "SHA-256" : "SHA-1";
  const digest = await crypto.subtle.digest(algorithm, object);
  return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, "0")).join("");
};

export async function parseGitHubApplyPayload(value: unknown, job: GitHubSourceJobRecord) {
  const object = objectValue(value);
  if (!object) throw new GitHubSourceContractError("GitHub apply payload는 객체여야 합니다.");
  exactKeys(object, ["preview", "documents", "reusedDocuments", "downloadedAt"], "GitHub apply payload");
  const preview = parseGitHubPreviewSnapshot(object.preview);
  if (
    job.kind !== "apply"
    || preview.status !== "ready"
    || preview.selectedRepositoryIds.length !== 1
    || preview.repositories.length !== 1
    || preview.manifestDigest !== job.input.manifestDigest
    || JSON.stringify(preview.selectedRepositoryIds) !== JSON.stringify(job.input.selectedRepositoryIds)
  ) {
    throw new GitHubSourceContractError("GitHub apply payload가 승인된 단일 저장소 preview와 일치하지 않습니다.");
  }
  const manifest = preview.repositories[0];
  if (manifest.status !== "ready") throw new GitHubSourceContractError("blocked manifest는 apply할 수 없습니다.");
  const manifestBytes = manifest.files.reduce((total, file) => total + file.size, 0);
  if (
    manifest.files.length > GITHUB_REPOSITORY_APPLY_MAX_FILES
    || manifestBytes > GITHUB_REPOSITORY_APPLY_MAX_BYTES
  ) throw new GitHubSourceContractError("저장소 apply manifest가 파일 또는 용량 안전 상한을 초과했습니다.");
  const plannedReuse = [...(job.input.reusableDocuments ?? [])]
    .sort((left, right) => left.path.localeCompare(right.path));
  const plannedReuseByPath = new Map<string, GitHubReusableDocument>();
  for (const item of plannedReuse) {
    if (plannedReuseByPath.has(item.path)) throw new GitHubSourceContractError("서버 reusable 문서 계획이 중복되었습니다.");
    const manifestFile = manifest.files.find((file) => file.path === item.path);
    if (
      item.repositoryId !== manifest.repositoryId
      || !manifestFile
      || item.blobSha !== manifestFile.blobSha
      || item.size !== manifestFile.size
    ) throw new GitHubSourceContractError(`서버 reusable 문서 계획이 manifest와 다릅니다: ${item.path}`);
    plannedReuseByPath.set(item.path, item);
  }
  if (!Array.isArray(object.documents) || object.documents.length > GITHUB_REPOSITORY_APPLY_MAX_FILES) {
    throw new GitHubSourceContractError(`저장소 apply 문서는 최대 ${GITHUB_REPOSITORY_APPLY_MAX_FILES}개입니다.`);
  }
  const documents: GitHubApplyDocumentPayload[] = [];
  let totalBytes = 0;
  for (const value of object.documents) {
    const document = objectValue(value);
    if (!document) throw new GitHubSourceContractError("GitHub apply 문서는 객체여야 합니다.");
    exactKeys(document, ["repositoryId", "path", "blobSha", "size", "content"], "GitHub apply 문서");
    const repositoryId = String(document.repositoryId ?? "");
    const path = String(document.path ?? "");
    const blobSha = String(document.blobSha ?? "").toLowerCase();
    const size = safeCount(document.size, "GitHub apply 문서 크기");
    const content = typeof document.content === "string" ? document.content : "";
    const manifestFile = manifest.files.find((file) => file.path === path);
    if (
      repositoryId !== manifest.repositoryId
      || !manifestFile
      || manifestFile.blobSha !== blobSha
      || manifestFile.size !== size
      || plannedReuseByPath.has(path)
    ) {
      throw new GitHubSourceContractError(`GitHub apply 문서가 preview manifest와 일치하지 않습니다: ${path}`);
    }
    const actualSize = new TextEncoder().encode(content).byteLength;
    if (actualSize !== size) throw new GitHubSourceContractError(`GitHub apply 문서 크기가 Blob metadata와 다릅니다: ${path}`);
    validateDecodedMarkdown(path, content, actualSize);
    if (await gitBlobDigest(content, blobSha.length) !== blobSha) {
      throw new GitHubSourceContractError(`GitHub apply 문서의 Git Blob SHA가 일치하지 않습니다: ${path}`);
    }
    totalBytes += actualSize;
    if (totalBytes > GITHUB_REPOSITORY_APPLY_MAX_BYTES) {
      throw new GitHubSourceContractError("저장소 apply 전체 용량이 8MB 안전 상한을 초과했습니다.");
    }
    documents.push({ repositoryId, path, blobSha, size, content });
  }
  documents.sort((left, right) => left.path.localeCompare(right.path));
  const reusedValues = object.reusedDocuments ?? [];
  if (!Array.isArray(reusedValues) || reusedValues.length > GITHUB_REPOSITORY_APPLY_MAX_FILES) {
    throw new GitHubSourceContractError(`재사용 apply 문서는 최대 ${GITHUB_REPOSITORY_APPLY_MAX_FILES}개입니다.`);
  }
  const reusedDocuments: GitHubReusableDocument[] = reusedValues.map((value) => {
    const document = objectValue(value);
    if (!document) throw new GitHubSourceContractError("재사용 GitHub 문서는 객체여야 합니다.");
    exactKeys(document, ["repositoryId", "path", "blobSha", "size"], "재사용 GitHub 문서");
    const item = {
      repositoryId: String(document.repositoryId ?? ""),
      path: String(document.path ?? ""),
      blobSha: String(document.blobSha ?? "").toLowerCase(),
      size: safeCount(document.size, "재사용 GitHub 문서 크기"),
    };
    const planned = plannedReuseByPath.get(item.path);
    if (
      !planned
      || planned.repositoryId !== item.repositoryId
      || planned.blobSha !== item.blobSha
      || planned.size !== item.size
    ) throw new GitHubSourceContractError(`재사용 GitHub 문서가 서버 계획과 다릅니다: ${item.path}`);
    return item;
  }).sort((left, right) => left.path.localeCompare(right.path));
  if (JSON.stringify(reusedDocuments) !== JSON.stringify(plannedReuse)) {
    throw new GitHubSourceContractError("재사용 GitHub 문서 집합이 서버 승인 계획과 일치하지 않습니다.");
  }
  const manifestPaths = manifest.files.map((file) => file.path).sort((left, right) => left.localeCompare(right));
  const submittedPaths = [
    ...documents.map((document) => document.path),
    ...reusedDocuments.map((document) => document.path),
  ].sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(submittedPaths) !== JSON.stringify(manifestPaths)) {
    throw new GitHubSourceContractError("GitHub apply 문서 집합이 preview manifest 전체와 일치하지 않습니다.");
  }
  const downloadedAt = String(object.downloadedAt ?? "");
  if (!Number.isFinite(Date.parse(downloadedAt))) throw new GitHubSourceContractError("GitHub apply downloadedAt 형식이 잘못되었습니다.");
  return { preview, documents, reusedDocuments, downloadedAt } satisfies GitHubApplyPayload;
}

export async function validateGitHubApplySubmission(
  value: unknown,
  job: GitHubSourceJobRecord,
): Promise<GitHubApplySubmission> {
  assertCredentialFreePayload(value);
  const object = objectValue(value);
  if (!object) throw new GitHubSourceContractError("GitHub apply 제출은 객체여야 합니다.");
  exactKeys(object, ["jobId", "idempotencyKey", "kind", "status", "capability", "summary", "applyPayload"], "GitHub apply 제출");
  if (
    job.kind !== "apply"
    || object.jobId !== job.id
    || object.idempotencyKey !== job.idempotencyKey
    || object.kind !== "apply"
    || object.status !== "completed"
  ) throw new GitHubSourceContractError("GitHub apply 제출 식별자가 작업과 일치하지 않습니다.");
  const capability = parseGitHubCapabilityReport(object.capability);
  if (capability.status !== "online") throw new GitHubSourceContractError("온라인 GitHub capability에서만 apply할 수 있습니다.");
  const summaryObject = objectValue(object.summary);
  if (!summaryObject) throw new GitHubSourceContractError("GitHub apply summary가 필요합니다.");
  exactKeys(summaryObject, ["discoveredCount", "selectedCount", "changedCount", "unchangedCount", "deletedCount", "failedCount"], "GitHub apply summary");
  const summary = {
    discoveredCount: safeCount(summaryObject.discoveredCount, "discoveredCount"),
    selectedCount: safeCount(summaryObject.selectedCount, "selectedCount"),
    changedCount: safeCount(summaryObject.changedCount, "changedCount"),
    unchangedCount: safeCount(summaryObject.unchangedCount, "unchangedCount"),
    deletedCount: safeCount(summaryObject.deletedCount, "deletedCount"),
    failedCount: safeCount(summaryObject.failedCount, "failedCount"),
  };
  const applyPayload = await parseGitHubApplyPayload(object.applyPayload, job);
  if (
    summary.discoveredCount !== 1
    || summary.selectedCount !== 1
    || summary.changedCount !== applyPayload.documents.length
    || summary.unchangedCount !== applyPayload.reusedDocuments.length
    || summary.deletedCount !== 0
    || summary.failedCount !== 0
  ) throw new GitHubSourceContractError("통합 런타임 apply summary가 다운로드 payload와 일치하지 않습니다.");
  return {
    jobId: job.id,
    idempotencyKey: job.idempotencyKey,
    kind: "apply",
    status: "completed",
    capability,
    summary,
    applyPayload,
  };
}
