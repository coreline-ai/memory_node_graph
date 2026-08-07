import type { GitHubApplyDocumentPayload } from "./apply-contracts.js";
import { GitHubSourceContractError } from "./source-job-contracts.js";

export const GITHUB_APPLY_INLINE_MAX_BYTES = 512 * 1024;
export const GITHUB_APPLY_CHUNK_MAX_BYTES = 5 * 1024 * 1024;
export const GITHUB_APPLY_CHUNK_MAX_FILES = 20;
export const GITHUB_APPLY_MAX_CHUNKS = 64;

export type GitHubApplyStageChunk = {
  jobId: string;
  chunkIndex: number;
  totalChunks: number;
  checksum: string;
  documents: GitHubApplyDocumentPayload[];
};

export type GitHubApplyStageReference = {
  totalChunks: number;
  stageDigest: string;
};

const digestPattern = /^[0-9a-f]{64}$/;
const objectValue = (value: unknown) =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const sha256 = async (value: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, "0")).join("");
};

const chunkChecksumInput = (
  jobId: string,
  chunkIndex: number,
  totalChunks: number,
  documents: readonly GitHubApplyDocumentPayload[],
) => JSON.stringify({ jobId, chunkIndex, totalChunks, documents });

export const stageDigestForChunks = async (
  chunks: readonly Pick<GitHubApplyStageChunk, "chunkIndex" | "checksum">[],
) => sha256(JSON.stringify([...chunks]
  .sort((left, right) => left.chunkIndex - right.chunkIndex)
  .map((chunk) => ({ chunkIndex: chunk.chunkIndex, checksum: chunk.checksum }))));

export async function createGitHubApplyStageChunks(
  jobId: string,
  documents: readonly GitHubApplyDocumentPayload[],
): Promise<{ chunks: GitHubApplyStageChunk[]; stage: GitHubApplyStageReference }> {
  const groups: GitHubApplyDocumentPayload[][] = [];
  let current: GitHubApplyDocumentPayload[] = [];
  for (const document of documents) {
    const singleBytes = new TextEncoder().encode(JSON.stringify([document])).byteLength;
    if (singleBytes > GITHUB_APPLY_CHUNK_MAX_BYTES) {
      throw new GitHubSourceContractError(`단일 Markdown chunk가 5MB 전송 상한을 초과했습니다: ${document.path}`);
    }
    const candidate = [...current, document];
    const candidateBytes = new TextEncoder().encode(JSON.stringify(candidate)).byteLength;
    if (
      current.length
      && (
        candidate.length > GITHUB_APPLY_CHUNK_MAX_FILES
        || candidateBytes > GITHUB_APPLY_CHUNK_MAX_BYTES
      )
    ) {
      groups.push(current);
      current = [document];
    } else {
      current = candidate;
    }
  }
  if (current.length) groups.push(current);
  if (!groups.length || groups.length > GITHUB_APPLY_MAX_CHUNKS) {
    throw new GitHubSourceContractError(`Apply stage는 1~${GITHUB_APPLY_MAX_CHUNKS}개 chunk여야 합니다.`);
  }
  const chunks: GitHubApplyStageChunk[] = [];
  for (let chunkIndex = 0; chunkIndex < groups.length; chunkIndex += 1) {
    const checksum = await sha256(chunkChecksumInput(jobId, chunkIndex, groups.length, groups[chunkIndex]));
    chunks.push({ jobId, chunkIndex, totalChunks: groups.length, checksum, documents: groups[chunkIndex] });
  }
  return {
    chunks,
    stage: {
      totalChunks: chunks.length,
      stageDigest: await stageDigestForChunks(chunks),
    },
  };
}

export async function parseGitHubApplyStageChunk(
  value: unknown,
  expectedJobId: string,
): Promise<GitHubApplyStageChunk> {
  const object = objectValue(value);
  if (!object) throw new GitHubSourceContractError("Apply stage chunk는 객체여야 합니다.");
  const unknown = Object.keys(object).filter((key) =>
    !["jobId", "chunkIndex", "totalChunks", "checksum", "documents"].includes(key));
  if (unknown.length) throw new GitHubSourceContractError(`Apply stage chunk에 허용되지 않은 필드가 있습니다: ${unknown.join(", ")}`);
  const jobId = String(object.jobId ?? "");
  const chunkIndex = Number(object.chunkIndex);
  const totalChunks = Number(object.totalChunks);
  const checksum = String(object.checksum ?? "").toLowerCase();
  if (jobId !== expectedJobId) throw new GitHubSourceContractError("Apply stage chunk 작업 ID가 다릅니다.");
  if (
    !Number.isSafeInteger(totalChunks)
    || totalChunks < 1
    || totalChunks > GITHUB_APPLY_MAX_CHUNKS
    || !Number.isSafeInteger(chunkIndex)
    || chunkIndex < 0
    || chunkIndex >= totalChunks
    || !digestPattern.test(checksum)
    || !Array.isArray(object.documents)
    || !object.documents.length
    || object.documents.length > GITHUB_APPLY_CHUNK_MAX_FILES
  ) throw new GitHubSourceContractError("Apply stage chunk 순서·개수·checksum 형식이 잘못되었습니다.");
  const documents = object.documents as GitHubApplyDocumentPayload[];
  const bytes = new TextEncoder().encode(JSON.stringify(documents)).byteLength;
  if (bytes > GITHUB_APPLY_CHUNK_MAX_BYTES) throw new GitHubSourceContractError("Apply stage chunk가 5MB 상한을 초과했습니다.");
  const expected = await sha256(chunkChecksumInput(jobId, chunkIndex, totalChunks, documents));
  if (expected !== checksum) throw new GitHubSourceContractError("Apply stage chunk checksum이 일치하지 않습니다.");
  return { jobId, chunkIndex, totalChunks, checksum, documents };
}

export function parseGitHubApplyStageReference(value: unknown): GitHubApplyStageReference {
  const object = objectValue(value);
  if (!object || Object.keys(object).some((key) => !["totalChunks", "stageDigest"].includes(key))) {
    throw new GitHubSourceContractError("Apply stage 참조 형식이 잘못되었습니다.");
  }
  const totalChunks = Number(object.totalChunks);
  const stageDigest = String(object.stageDigest ?? "").toLowerCase();
  if (
    !Number.isSafeInteger(totalChunks)
    || totalChunks < 1
    || totalChunks > GITHUB_APPLY_MAX_CHUNKS
    || !digestPattern.test(stageDigest)
  ) throw new GitHubSourceContractError("Apply stage 참조 순서·digest가 잘못되었습니다.");
  return { totalChunks, stageDigest };
}

export async function hydrateGitHubApplyStageSubmission(
  value: unknown,
  jobId: string,
  storedChunks: readonly GitHubApplyStageChunk[],
): Promise<{ submission: unknown; staged: boolean }> {
  const submission = objectValue(value);
  const applyPayload = objectValue(submission?.applyPayload);
  if (!submission || !applyPayload || applyPayload.stage === undefined) {
    return { submission: value, staged: false };
  }
  const payloadUnknown = Object.keys(applyPayload).filter((key) =>
    !["preview", "reusedDocuments", "downloadedAt", "stage"].includes(key));
  if (payloadUnknown.length) {
    throw new GitHubSourceContractError(`Staged Apply payload에 허용되지 않은 필드가 있습니다: ${payloadUnknown.join(", ")}`);
  }
  const stage = parseGitHubApplyStageReference(applyPayload.stage);
  if (storedChunks.length !== stage.totalChunks) {
    throw new GitHubSourceContractError("Apply stage chunk가 모두 업로드되지 않았습니다.");
  }
  const chunks: GitHubApplyStageChunk[] = [];
  for (const stored of storedChunks) chunks.push(await parseGitHubApplyStageChunk(stored, jobId));
  if (chunks.some((chunk, index) => chunk.chunkIndex !== index || chunk.totalChunks !== stage.totalChunks)) {
    throw new GitHubSourceContractError("Apply stage chunk 순서 또는 totalChunks가 일치하지 않습니다.");
  }
  if (await stageDigestForChunks(chunks) !== stage.stageDigest) {
    throw new GitHubSourceContractError("Apply stage 전체 digest가 일치하지 않습니다.");
  }
  return {
    staged: true,
    submission: {
      ...submission,
      applyPayload: {
        preview: applyPayload.preview,
        documents: chunks.flatMap((chunk) => chunk.documents),
        reusedDocuments: applyPayload.reusedDocuments,
        downloadedAt: applyPayload.downloadedAt,
      },
    },
  };
}
