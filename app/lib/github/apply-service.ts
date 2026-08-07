import type { GitHubApplyPayload } from "./apply-contracts";
import type { GitHubApplyReceipt } from "./source-job-contracts";
import { prepareMarkdownIngestion } from "../ingestion/ingestion-service";
import { parserVersionForMarkdownSource } from "../markdown/parser-profiles";
import { schedulePreparedDocumentsEnrichment } from "../ingestion/enrichment-scheduler";
import {
  createGitHubDocumentSourceDescriptor,
  documentSourceKey,
} from "../ingestion/document-source";
import {
  findGitHubApplyReceipt,
  listGitHubRepositoryDocuments,
  replaceGitHubRepositoryDocuments,
  type GitHubRepositoryPreparedDocument,
  type GitHubRepositoryUnchangedDocument,
} from "../storage/graph-repository";

export async function applySingleGitHubRepository(input: {
  jobId: string;
  payload: GitHubApplyPayload;
  appliedAt?: string;
}): Promise<GitHubApplyReceipt> {
  const manifest = input.payload.preview.repositories[0];
  if (
    input.payload.preview.status !== "ready"
    || input.payload.preview.repositories.length !== 1
    || manifest.status !== "ready"
  ) throw new Error("ready 상태의 단일 저장소 preview만 apply할 수 있습니다.");

  const recoveredReceipt = await findGitHubApplyReceipt(input.jobId);
  if (recoveredReceipt) {
    if (
      recoveredReceipt.repositoryId !== manifest.repositoryId
      || recoveredReceipt.manifestDigest !== input.payload.preview.manifestDigest
    ) throw new Error("기존 apply 영수증이 현재 작업과 일치하지 않습니다.");
    return recoveredReceipt;
  }

  const preparedDocuments: GitHubRepositoryPreparedDocument[] = [];
  const unchangedDocuments: GitHubRepositoryUnchangedDocument[] = [];
  const existingDocuments = new Map(
    (await listGitHubRepositoryDocuments(manifest.repositoryId))
      .map((document) => [document.sourceKey, document]),
  );
  const downloadedByPath = new Map(input.payload.documents.map((document) => [document.path, document]));
  const reusedPaths = new Set(input.payload.reusedDocuments.map((document) => document.path));
  for (const manifestFile of manifest.files) {
    const sourceDescriptor = createGitHubDocumentSourceDescriptor({
      repositoryId: manifest.repositoryId,
      repositoryOwner: manifest.owner,
      repositoryName: manifest.repositoryName,
      relativePath: manifestFile.path,
      ref: manifest.defaultBranch,
      commitSha: manifest.commitSha,
      blobSha: manifestFile.blobSha,
      sourceUrl: manifestFile.sourceUrl,
    });
    const existing = existingDocuments.get(documentSourceKey(sourceDescriptor));
    const parserVersion = parserVersionForMarkdownSource(sourceDescriptor);
    if (reusedPaths.has(manifestFile.path)) {
      if (
        existing?.sourceDescriptor.type !== "github"
        || existing.sourceDescriptor.blobSha !== sourceDescriptor.blobSha
        || existing.parserVersion !== parserVersion
      ) throw new Error(`재사용할 기존 Blob 상태가 변경되었습니다: ${manifestFile.path}`);
      unchangedDocuments.push({ sourceDescriptor });
      continue;
    }
    const payloadDocument = downloadedByPath.get(manifestFile.path);
    if (!payloadDocument) throw new Error(`다운로드한 manifest 파일을 찾을 수 없습니다: ${manifestFile.path}`);
    if (
      existing?.sourceDescriptor.type === "github"
      && existing.sourceDescriptor.blobSha === sourceDescriptor.blobSha
      && existing.parserVersion === parserVersion
    ) {
      unchangedDocuments.push({ sourceDescriptor });
      continue;
    }
    const prepared = await prepareMarkdownIngestion({
      fileName: payloadDocument.path.split("/").at(-1) ?? payloadDocument.path,
      source: payloadDocument.content,
      size: payloadDocument.size,
      forceReindex: true,
      sourceDescriptor,
    });
    if (prepared.unchanged || !prepared.graph) {
      throw new Error(`저장소 apply 파싱 결과가 준비되지 않았습니다: ${payloadDocument.path}`);
    }
    preparedDocuments.push({
      document: prepared.document,
      source: prepared.normalizedSource,
      sourceDescriptor,
      graph: prepared.graph,
      job: prepared.job,
    });
  }
  const result = await replaceGitHubRepositoryDocuments({
    repositoryId: manifest.repositoryId,
    syncId: input.jobId,
    documents: preparedDocuments,
    unchangedDocuments,
    receipt: {
      repositoryName: manifest.repositoryName,
      commitSha: manifest.commitSha,
      manifestDigest: input.payload.preview.manifestDigest,
      appliedAt: input.appliedAt ?? new Date().toISOString(),
    },
  });
  const schedules = await schedulePreparedDocumentsEnrichment({
    documents: preparedDocuments,
  });
  const warnings = schedules.filter((item) => item.warning);
  if (warnings.length) {
    console.warn(
      `[atlas] GitHub Apply ${input.jobId} 그래프 저장은 완료됐지만 ${warnings.length}개 문서의 보강 작업 등록이 실패했습니다.`,
    );
  }
  return result;
}
