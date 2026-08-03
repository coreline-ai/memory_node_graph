import type { KnowledgeEdge, KnowledgeNode } from "../../graph-data";
import type { EnrichmentErrorCode, EnrichmentJobStatus } from "../llm/enrichment-contracts";

export type GraphSource = "demo" | "documents";

export type GraphSnapshot = {
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
  meta: {
    source: GraphSource;
    provider: "built-in" | "markdown-ast" | "performance-fixture";
    generatedAt: string;
    documentCount?: number;
    message?: string;
  };
};

export type DocumentStatus =
  | "queued"
  | "validating"
  | "parsing"
  | "unchanged"
  | "completed"
  | "failed";

export type DocumentRecord = {
  id: string;
  fileName: string;
  normalizedName: string;
  size: number;
  hash: string;
  status: DocumentStatus;
  nodeCount: number;
  edgeCount: number;
  parserVersion: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
};

export type IngestionJob = {
  id: string;
  documentId: string;
  fileName: string;
  status: DocumentStatus;
  progress: number;
  message: string;
  createdAt: string;
  completedAt?: string;
};

export type DashboardSnapshot = {
  documents: DocumentRecord[];
  jobs: IngestionJob[];
  enrichmentJobs: DashboardEnrichmentJob[];
  connector: ConnectorStatusSummary;
  totals: {
    documents: number;
    nodes: number;
    edges: number;
    processing: number;
    failed: number;
    enrichmentQueued: number;
    enrichmentActive: number;
    enrichmentWarnings: number;
  };
  storage: "d1" | "memory";
};

export type DashboardEnrichmentJob = {
  id: string;
  documentId: string;
  status: EnrichmentJobStatus;
  attemptCount: number;
  maxAttempts: number;
  manualRetryCount: number;
  maxManualRetries: number;
  providerVersion: string;
  promptVersion: string;
  relationCount: number;
  warningCount: number;
  inputTokens?: number;
  outputTokens?: number;
  errorCode?: EnrichmentErrorCode;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};

export type ConnectorStatusSummary = {
  status: "online" | "offline";
  onlineCount: number;
  queuedJobs: number;
  activeJobs: number;
  lastSeenAt?: string;
  currentJobId?: string;
};
