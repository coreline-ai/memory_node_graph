import type { DashboardSnapshot, DocumentRecord } from "../graph/model";

export type DocumentMutationOperation =
  | "created"
  | "updated"
  | "unchanged"
  | "reindexed"
  | "deleted"
  | "failed";

export type DocumentMutationReceipt = {
  fileName: string;
  documentId?: string;
  operation: DocumentMutationOperation;
  status: "completed" | "unchanged" | "failed";
  nodes: { before: number; after: number; delta: number };
  edges: { before: number; after: number; delta: number };
  message: string;
  warning?: string;
};

export type DocumentMutationSummary = {
  completed: number;
  unchanged: number;
  failed: number;
  nodeDelta: number;
  edgeDelta: number;
};

export type DocumentMutationResponse = {
  receipts: DocumentMutationReceipt[];
  summary: DocumentMutationSummary;
  snapshot: DashboardSnapshot;
  graphRevision: string;
};

const delta = (before: number, after: number) => ({ before, after, delta: after - before });

export function completedDocumentMutationReceipt(input: {
  document: DocumentRecord;
  operation: Exclude<DocumentMutationOperation, "failed" | "deleted">;
  before?: { nodes: number; edges: number };
  message: string;
  warning?: string;
}): DocumentMutationReceipt {
  const before = input.before ?? { nodes: 0, edges: 0 };
  return {
    fileName: input.document.fileName,
    documentId: input.document.id,
    operation: input.operation,
    status: input.operation === "unchanged" ? "unchanged" : "completed",
    nodes: delta(before.nodes, input.document.nodeCount),
    edges: delta(before.edges, input.document.edgeCount),
    message: input.message,
    warning: input.warning,
  };
}

export function deletedDocumentMutationReceipt(document: DocumentRecord): DocumentMutationReceipt {
  return {
    fileName: document.fileName,
    documentId: document.id,
    operation: "deleted",
    status: "completed",
    nodes: delta(document.nodeCount, 0),
    edges: delta(document.edgeCount, 0),
    message: `${document.nodeCount}개 노드 · ${document.edgeCount}개 관계를 문서와 함께 제거했습니다.`,
  };
}

export function failedDocumentMutationReceipt(fileName: string, error: unknown): DocumentMutationReceipt {
  const message = error instanceof Error ? error.message : "문서를 처리하지 못했습니다.";
  return {
    fileName,
    operation: "failed",
    status: "failed",
    nodes: delta(0, 0),
    edges: delta(0, 0),
    message,
  };
}

export function summarizeDocumentMutations(receipts: readonly DocumentMutationReceipt[]): DocumentMutationSummary {
  return receipts.reduce<DocumentMutationSummary>((summary, receipt) => ({
    completed: summary.completed + Number(receipt.status === "completed"),
    unchanged: summary.unchanged + Number(receipt.status === "unchanged"),
    failed: summary.failed + Number(receipt.status === "failed"),
    nodeDelta: summary.nodeDelta + receipt.nodes.delta,
    edgeDelta: summary.edgeDelta + receipt.edges.delta,
  }), { completed: 0, unchanged: 0, failed: 0, nodeDelta: 0, edgeDelta: 0 });
}

export function documentMutationResponse(
  receipts: DocumentMutationReceipt[],
  snapshot: DashboardSnapshot,
): DocumentMutationResponse {
  return {
    receipts,
    summary: summarizeDocumentMutations(receipts),
    snapshot,
    graphRevision: snapshot.graphRevision,
  };
}
