import type { DocumentRecord } from "../graph/model";
import type { ExtractedGraph } from "../markdown/extract-graph";
import {
  buildEnrichmentJobInputs,
  createEvidenceBlockChunks,
  ENRICHMENT_ONTOLOGY_VERSION,
} from "../llm/enrichment-contracts";
import {
  getEnrichmentJobRepository,
  type EnqueueEnrichmentJobResult,
} from "../storage/enrichment-job-repository";

export const DEFAULT_CODEX_PROVIDER_VERSION = "codex-sdk-0.146.0";

export type EnrichmentScheduleResult = {
  jobs: EnqueueEnrichmentJobResult[];
  chunkCount: number;
  createdCount: number;
  existingCount: number;
  ontologyVersion: string;
};

export function estimateEnrichmentSchedule(graph: ExtractedGraph) {
  const chunks = createEvidenceBlockChunks(graph.blocks);
  return {
    chunkCount: Math.max(1, chunks.length),
    evidenceBlockCount: graph.blocks.length,
    ontologyVersion: ENRICHMENT_ONTOLOGY_VERSION,
  };
}

export async function scheduleDocumentEnrichment(input: {
  document: DocumentRecord;
  graph: ExtractedGraph;
  forceReprocess?: boolean;
  reprocessNonce?: string;
  providerVersion?: string;
  markExistingStale?: boolean;
}): Promise<EnrichmentScheduleResult> {
  const repository = await getEnrichmentJobRepository();
  if (input.markExistingStale !== false) {
    await repository.markDocumentStale(
      input.document.id,
      input.document.hash,
      undefined,
      input.forceReprocess === true,
    );
  }
  const jobs = await buildEnrichmentJobInputs({
    document: {
      id: input.document.id,
      name: input.document.fileName,
      hash: input.document.hash,
      parserVersion: input.document.parserVersion,
    },
    providerVersion: input.providerVersion
      ?? process.env.ATLAS_CODEX_PROVIDER_VERSION?.trim()
      ?? DEFAULT_CODEX_PROVIDER_VERSION,
    nodes: input.graph.nodes,
    existingRelations: input.graph.edges,
    blocks: input.graph.blocks,
    nodeBlockIds: input.graph.nodeBlockIds,
    reprocessNonce: input.forceReprocess
      ? input.reprocessNonce ?? crypto.randomUUID()
      : undefined,
  });
  const outcomes: EnqueueEnrichmentJobResult[] = [];
  for (const job of jobs) outcomes.push(await repository.enqueue(job));
  const createdCount = outcomes.filter((outcome) => outcome.created).length;
  return {
    jobs: outcomes,
    chunkCount: jobs.length,
    createdCount,
    existingCount: outcomes.length - createdCount,
    ontologyVersion: ENRICHMENT_ONTOLOGY_VERSION,
  };
}

export async function schedulePreparedDocumentsEnrichment(input: {
  documents: Array<{ document: DocumentRecord; graph: ExtractedGraph }>;
  providerVersion?: string;
}) {
  const results: Array<{
    documentId: string;
    schedule?: EnrichmentScheduleResult;
    warning?: string;
  }> = [];
  for (const item of input.documents) {
    try {
      results.push({
        documentId: item.document.id,
        schedule: await scheduleDocumentEnrichment({
          document: item.document,
          graph: item.graph,
          providerVersion: input.providerVersion,
        }),
      });
    } catch (error) {
      results.push({
        documentId: item.document.id,
        warning: error instanceof Error ? error.message : "보강 작업 등록 실패",
      });
    }
  }
  return results;
}
