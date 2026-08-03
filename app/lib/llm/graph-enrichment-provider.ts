import type { KnowledgeEdge, KnowledgeNode } from "../../graph-data";

export type GraphEnrichmentInput = {
  documentName: string;
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
};

export interface GraphEnrichmentProvider {
  readonly name: string;
  enrich(input: GraphEnrichmentInput): Promise<KnowledgeEdge[]>;
}

export const graphEnrichmentEnabled = () =>
  process.env.GRAPH_LLM_ENRICHMENT_ENABLED?.trim().toLowerCase() === "true";
