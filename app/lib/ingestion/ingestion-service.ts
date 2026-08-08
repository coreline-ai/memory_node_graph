import type { DocumentRecord, DocumentSourceDescriptor, IngestionJob } from "../graph/model";
import { extractGraphForSource, parserVersionForMarkdownSource } from "../markdown/parser-profiles";
import { parseMarkdown } from "../markdown/parse-markdown";
import { normalizeFileName, normalizeMarkdown, sha256 } from "../markdown/normalize";
import {
  MAX_MARKDOWN_FILE_SIZE,
  MAX_MARKDOWN_FILES,
  validateMarkdownFileName,
} from "../markdown/validate-markdown";
import {
  findDocumentById,
  findDocumentBySourceKey,
  saveDocument,
  saveUnchangedJob,
  toPublicDocumentRecord,
} from "../storage/graph-repository";
import { scheduleDocumentEnrichment } from "./enrichment-scheduler";
import {
  createManualDocumentSourceDescriptor,
  documentIdForSource,
  documentSourceKey,
} from "./document-source";

export { MAX_MARKDOWN_FILE_SIZE, MAX_MARKDOWN_FILES };

const jobFor = (
  documentId: string,
  fileName: string,
  status: IngestionJob["status"],
  message: string,
): IngestionJob => {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    documentId,
    fileName,
    status,
    progress: status === "completed" || status === "unchanged" ? 100 : 0,
    message,
    createdAt: now,
    completedAt: status === "completed" || status === "unchanged" ? now : undefined,
  };
};

export async function prepareMarkdownIngestion(input: {
  fileName: string;
  source: string;
  size?: number;
  forceReindex?: boolean;
  sourceDescriptor?: DocumentSourceDescriptor;
}) {
  validateMarkdownFileName(input.fileName);
  const normalizedSource = normalizeMarkdown(input.source);
  const size = input.size ?? new TextEncoder().encode(normalizedSource).byteLength;
  if (size > MAX_MARKDOWN_FILE_SIZE) {
    throw new Error(`${input.fileName}: 파일 크기는 2MB 이하여야 합니다.`);
  }
  if (!normalizedSource.trim()) throw new Error(`${input.fileName}: 빈 문서는 처리할 수 없습니다.`);

  const normalizedName = normalizeFileName(input.fileName);
  const sourceDescriptor = input.sourceDescriptor ?? createManualDocumentSourceDescriptor(input.fileName);
  if (sourceDescriptor.type === "manual" && sourceDescriptor.normalizedName !== normalizedName) {
    throw new Error("수동 문서 source descriptor와 파일명이 일치하지 않습니다.");
  }
  const sourceKey = documentSourceKey(sourceDescriptor);
  const hash = await sha256(normalizedSource);
  const existing = await findDocumentBySourceKey(sourceKey);
  const documentId = existing?.id ?? await documentIdForSource(sourceDescriptor);
  const sameHash = existing?.hash === hash;
  const parserVersion = parserVersionForMarkdownSource(sourceDescriptor);

  if (sameHash && existing?.parserVersion === parserVersion && !input.forceReindex) {
    const job = jobFor(documentId, input.fileName, "unchanged", "변경된 내용 없음");
    return {
      document: toPublicDocumentRecord(existing),
      job,
      operation: "unchanged" as const,
      before: { nodes: existing.nodeCount, edges: existing.edgeCount },
      unchanged: true as const,
      sameHash: true,
      existed: true,
      normalizedSource,
      sourceDescriptor,
      graph: undefined,
    };
  }

  const root = parseMarkdown(normalizedSource);
  const graph = await extractGraphForSource(root, {
    documentId,
    fileName: input.fileName,
    sourceDescriptor,
  });
  const now = new Date().toISOString();
  const document: DocumentRecord = {
    id: documentId,
    fileName: input.fileName,
    normalizedName,
    size,
    hash,
    status: "completed",
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    parserVersion,
    sourceType: sourceDescriptor.type,
    sourceLabel: sourceDescriptor.type === "github"
      ? `${sourceDescriptor.repositoryName} · ${sourceDescriptor.relativePath}`
      : "수동 업로드",
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  const job = jobFor(
    documentId,
    input.fileName,
    "completed",
    `${graph.nodes.length}개 노드 · ${graph.edges.length}개 기본 관계 생성`,
  );
  return {
    document,
    job,
    operation: existing ? "updated" as const : "created" as const,
    before: { nodes: existing?.nodeCount ?? 0, edges: existing?.edgeCount ?? 0 },
    unchanged: false as const,
    sameHash,
    existed: Boolean(existing),
    normalizedSource,
    sourceDescriptor,
    graph,
  };
}

export async function ingestMarkdown(input: {
  fileName: string;
  source: string;
  size?: number;
  forceReindex?: boolean;
  sourceDescriptor?: DocumentSourceDescriptor;
}) {
  const prepared = await prepareMarkdownIngestion(input);
  if (prepared.unchanged) {
    await saveUnchangedJob(prepared.job);
    return {
      document: prepared.document,
      job: prepared.job,
      operation: prepared.operation,
      before: prepared.before,
      unchanged: true,
    };
  }
  const {
    document,
    job,
    graph,
    normalizedSource,
    sourceDescriptor,
  } = prepared;
  let enrichment: Awaited<ReturnType<typeof scheduleDocumentEnrichment>>["jobs"][number] | null = null;
  let enrichmentSchedule: Awaited<ReturnType<typeof scheduleDocumentEnrichment>> | null = null;
  let enrichmentWarning: string | undefined;
  await saveDocument({ document, source: normalizedSource, sourceDescriptor, graph, job });
  try {
    enrichmentSchedule = await scheduleDocumentEnrichment({
      document,
      graph,
      forceReprocess: input.forceReindex,
    });
    enrichment = enrichmentSchedule.jobs[0] ?? null;
  } catch (error) {
    enrichmentWarning = error instanceof Error ? error.message : "보강 작업을 등록하지 못했습니다.";
  }
  return {
    document,
    job,
    operation: prepared.operation,
    before: prepared.before,
    enrichment,
    enrichmentSchedule,
    enrichmentWarning,
    unchanged: false,
  };
}

export async function reindexDocument(id: string) {
  const document = await findDocumentById(id);
  if (!document) throw new Error("문서를 찾을 수 없습니다.");
  return ingestMarkdown({
    fileName: document.fileName,
    source: document.source,
    size: document.size,
    forceReindex: true,
    sourceDescriptor: document.sourceDescriptor,
  });
}
