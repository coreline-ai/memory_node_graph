import type {
  DocumentSourceDescriptor,
  DocumentSourceKey,
  GitHubDocumentSourceDescriptor,
  ManualDocumentSourceDescriptor,
} from "../graph/model";
import { normalizeFileName, sha256 } from "../markdown/normalize.js";

const GITHUB_OBJECT_ID_PATTERN = /^[0-9a-f]{40,64}$/i;
const GITHUB_REPOSITORY_ID_PATTERN = /^[1-9][0-9]*$/;

function requireNonEmpty(value: string, field: string) {
  if (!value.trim()) throw new Error(`${field} 값이 필요합니다.`);
  return value;
}

function validateRepositoryId(repositoryId: string) {
  if (!GITHUB_REPOSITORY_ID_PATTERN.test(repositoryId)) {
    throw new Error("GitHub repositoryId는 0이 아닌 숫자 문자열이어야 합니다.");
  }
  return repositoryId;
}

function validateRelativePath(relativePath: string) {
  requireNonEmpty(relativePath, "relativePath");
  if (
    relativePath.startsWith("/") ||
    relativePath.includes("\\") ||
    relativePath.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("GitHub relativePath는 정규화된 저장소 상대 경로여야 합니다.");
  }
  return relativePath;
}

function validateObjectId(value: string, field: "commitSha" | "blobSha") {
  if (!GITHUB_OBJECT_ID_PATTERN.test(value)) {
    throw new Error(`${field}는 40~64자리 Git object ID여야 합니다.`);
  }
  return value.toLowerCase();
}

function validateSourceUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new Error("GitHub sourceUrl은 HTTPS URL이어야 합니다.");
  }
  return url.toString();
}

export function createManualDocumentSourceDescriptor(
  fileName: string,
): ManualDocumentSourceDescriptor {
  const normalizedName = normalizeFileName(fileName);
  requireNonEmpty(normalizedName, "fileName");
  return { type: "manual", normalizedName };
}

export function createGitHubDocumentSourceDescriptor(input: {
  repositoryId: string;
  repositoryOwner: string;
  repositoryName: string;
  relativePath: string;
  ref: string;
  commitSha: string;
  blobSha: string;
  sourceUrl: string;
}): GitHubDocumentSourceDescriptor {
  return {
    type: "github",
    repositoryId: validateRepositoryId(input.repositoryId),
    repositoryOwner: requireNonEmpty(input.repositoryOwner, "repositoryOwner"),
    repositoryName: requireNonEmpty(input.repositoryName, "repositoryName"),
    relativePath: validateRelativePath(input.relativePath),
    ref: requireNonEmpty(input.ref, "ref"),
    commitSha: validateObjectId(input.commitSha, "commitSha"),
    blobSha: validateObjectId(input.blobSha, "blobSha"),
    sourceUrl: validateSourceUrl(input.sourceUrl),
  };
}

export function documentSourceKey(
  descriptor: DocumentSourceDescriptor,
): DocumentSourceKey {
  if (descriptor.type === "manual") {
    const normalizedName = normalizeFileName(descriptor.normalizedName);
    requireNonEmpty(normalizedName, "normalizedName");
    if (descriptor.normalizedName !== normalizedName) {
      throw new Error("수동 문서 normalizedName은 정규화된 값이어야 합니다.");
    }
    return `manual:${normalizedName}`;
  }

  const repositoryId = validateRepositoryId(descriptor.repositoryId);
  const relativePath = validateRelativePath(descriptor.relativePath);
  return `github:${repositoryId}:${relativePath}`;
}

export async function documentIdForSourceKey(sourceKey: DocumentSourceKey) {
  return `document-${await sha256(sourceKey)}`;
}

export async function documentIdForSource(
  descriptor: DocumentSourceDescriptor,
) {
  return documentIdForSourceKey(documentSourceKey(descriptor));
}
