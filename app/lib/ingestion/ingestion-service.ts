import type { DocumentRecord, IngestionJob } from "../graph/model";
import { buildEnrichmentJobInput } from "../llm/enrichment-contracts";
import { extractGraph } from "../markdown/extract-graph";
import { MARKDOWN_PARSER_VERSION, parseMarkdown } from "../markdown/parse-markdown";
import { normalizeFileName, normalizeMarkdown, sha256, stableKey } from "../markdown/normalize";
import {
  MAX_MARKDOWN_FILE_SIZE,
  MAX_MARKDOWN_FILES,
  validateMarkdownFileName,
} from "../markdown/validate-markdown";
import {
  findDocumentById,
  findDocumentByName,
  saveDocument,
  saveUnchangedJob,
} from "../storage/graph-repository";
import {
  getEnrichmentJobRepository,
  type EnqueueEnrichmentJobResult,
} from "../storage/enrichment-job-repository";

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

export async function ingestMarkdown(input: {
  fileName: string;
  source: string;
  size?: number;
}) {
  validateMarkdownFileName(input.fileName);
  const normalizedSource = normalizeMarkdown(input.source);
  const size = input.size ?? new TextEncoder().encode(normalizedSource).byteLength;
  if (size > MAX_MARKDOWN_FILE_SIZE) {
    throw new Error(`${input.fileName}: 파일 크기는 2MB 이하여야 합니다.`);
  }
  if (!normalizedSource.trim()) throw new Error(`${input.fileName}: 빈 문서는 처리할 수 없습니다.`);

  const normalizedName = normalizeFileName(input.fileName);
  const hash = await sha256(normalizedSource);
  const existing = await findDocumentByName(normalizedName);
  const documentId = existing?.id ?? `document-${stableKey(normalizedName)}`;

  if (existing?.hash === hash) {
    const job = jobFor(documentId, input.fileName, "unchanged", "변경된 내용 없음");
    await saveUnchangedJob(job);
    return { document: existing as DocumentRecord, job, unchanged: true };
  }

  const root = parseMarkdown(normalizedSource);
  const graph = extractGraph(root, documentId, input.fileName);
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
    parserVersion: MARKDOWN_PARSER_VERSION,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  const job = jobFor(
    documentId,
    input.fileName,
    "completed",
    `${graph.nodes.length}개 노드 · ${graph.edges.length}개 기본 관계 생성`,
  );
  await saveDocument({ document, source: normalizedSource, graph, job });
  let enrichment: EnqueueEnrichmentJobResult | null = null;
  let enrichmentWarning: string | undefined;
  try {
    const repository = await getEnrichmentJobRepository();
    await repository.markDocumentStale(document.id, document.hash);
    const enrichmentInput = await buildEnrichmentJobInput({
      document: {
        id: document.id,
        name: document.fileName,
        hash: document.hash,
        parserVersion: document.parserVersion,
      },
      providerVersion: process.env.ATLAS_CODEX_PROVIDER_VERSION?.trim() || "codex-sdk-0.146.0",
      nodes: graph.nodes,
      existingRelations: graph.edges,
      blocks: graph.blocks,
    });
    enrichment = await repository.enqueue(enrichmentInput);
  } catch (error) {
    enrichmentWarning = error instanceof Error ? error.message : "보강 작업을 등록하지 못했습니다.";
  }
  return { document, job, enrichment, enrichmentWarning, unchanged: false };
}

export async function reindexDocument(id: string) {
  const document = await findDocumentById(id);
  if (!document) throw new Error("문서를 찾을 수 없습니다.");
  return ingestMarkdown({
    fileName: document.fileName,
    source: document.source,
    size: document.size,
  });
}
