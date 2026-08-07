import type { KnowledgeEdge, KnowledgeNode } from "../../graph-data";
import type { EnrichmentErrorCode, EnrichmentJobStatus } from "../llm/enrichment-contracts";

export type GraphSource = "demo" | "documents";

export type GraphSnapshot = {
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
  meta: {
    source: GraphSource;
    provider: "built-in" | "markdown-ast" | "performance-fixture" | "gold-graph-fixture";
    generatedAt: string;
    documentCount?: number;
    message?: string;
    scope?: "corpus" | "overview" | "repository";
    repositoryId?: string;
    repositoryCount?: number;
    nodeBudget?: number;
    edgeBudget?: number;
    totalNodeCount?: number;
    omittedNodeCount?: number;
    totalEdgeCount?: number;
    omittedEdgeCount?: number;
    corpusNodeCount?: number;
    corpusEdgeCount?: number;
    projectionMode?: "full-corpus-knowledge-map" | "single-repository-knowledge-map" | "multi-repository-shared-knowledge" | "repository-evidence-graph";
    analytics?: {
      algorithm: string;
      communityCount: number;
      componentCount: number;
      density: number;
      leafRatio: number;
      nonStructuralRatio: number;
      inferredEvidenceCoverage: number;
      communities: Array<{
        id: string;
        label: string;
        size: number;
        representativeNodeId: string;
      }>;
    };
  };
};

export type DocumentStatus =
  | "queued"
  | "validating"
  | "parsing"
  | "unchanged"
  | "completed"
  | "failed";

export type DocumentSourceKey =
  | `manual:${string}`
  | `github:${string}:${string}`;

export type ManualDocumentSourceDescriptor = {
  type: "manual";
  normalizedName: string;
};

export type GitHubDocumentSourceDescriptor = {
  type: "github";
  repositoryId: string;
  repositoryOwner: string;
  repositoryName: string;
  relativePath: string;
  ref: string;
  commitSha: string;
  blobSha: string;
  sourceUrl: string;
};

export type DocumentSourceDescriptor =
  | ManualDocumentSourceDescriptor
  | GitHubDocumentSourceDescriptor;

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
  sourceType: DocumentSourceDescriptor["type"];
  sourceLabel: string;
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

export type GitHubRepositoryStorageSummary = {
  repositoryId: string;
  repositoryOwner: string;
  repositoryName: string;
  documentCount: number;
  nodeCount: number;
  edgeCount: number;
  commitSha?: string;
  manifestDigest?: string;
  lastSyncedAt: string;
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
  ontologyVersion?: string;
  chunkIndex?: number;
  chunkCount?: number;
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
  runMode?: "continuous" | "bounded";
  maxJobs?: number;
  maxRuntimeMs?: number;
  processedJobs?: number;
  succeededJobs?: number;
  warningJobs?: number;
  failedJobs?: number;
  stopReason?: "dry_run" | "job_limit" | "runtime_limit" | "idle" | "once" | "signal" | "fatal";
};
