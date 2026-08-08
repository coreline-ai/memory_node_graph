import assert from "node:assert/strict";
import test from "node:test";

import {
  completedDocumentMutationReceipt,
  deletedDocumentMutationReceipt,
  documentMutationResponse,
  failedDocumentMutationReceipt,
  summarizeDocumentMutations,
} from "../.runtime-dist/app/lib/ingestion/document-mutation-receipt.js";

const document = {
  id: "document-atlas",
  fileName: "atlas.md",
  normalizedName: "atlas.md",
  size: 128,
  hash: "hash",
  status: "completed",
  nodeCount: 8,
  edgeCount: 7,
  parserVersion: "remark-ast-1",
  sourceType: "manual",
  sourceLabel: "수동 업로드",
  createdAt: "2026-08-07T00:00:00.000Z",
  updatedAt: "2026-08-07T00:00:01.000Z",
};

test("문서 반영 영수증은 신규·갱신·동일·실패의 수량 변화를 일관되게 집계한다", () => {
  const created = completedDocumentMutationReceipt({
    document,
    operation: "created",
    message: "기본 그래프 생성",
  });
  const unchanged = completedDocumentMutationReceipt({
    document,
    operation: "unchanged",
    before: { nodes: 8, edges: 7 },
    message: "변경된 내용 없음",
  });
  const failed = failedDocumentMutationReceipt("broken.md", new Error("UTF-8 오류"));

  assert.deepEqual(created.nodes, { before: 0, after: 8, delta: 8 });
  assert.equal(unchanged.status, "unchanged");
  assert.deepEqual(unchanged.edges, { before: 7, after: 7, delta: 0 });
  assert.equal(failed.message, "UTF-8 오류");
  assert.deepEqual(summarizeDocumentMutations([created, unchanged, failed]), {
    completed: 1,
    unchanged: 1,
    failed: 1,
    nodeDelta: 8,
    edgeDelta: 7,
  });
});

test("삭제 영수증과 응답은 제거된 그래프 수량과 snapshot revision을 전달한다", () => {
  const receipt = deletedDocumentMutationReceipt(document);
  const snapshot = {
    documents: [],
    jobs: [],
    enrichmentJobs: [],
    runtime: { status: "offline", onlineCount: 0, queuedJobs: 0, activeJobs: 0 },
    totals: {
      documents: 0,
      nodes: 0,
      edges: 0,
      processing: 0,
      failed: 0,
      enrichmentQueued: 0,
      enrichmentActive: 0,
      enrichmentWarnings: 0,
    },
    storage: "memory",
    graphRevision: "atlas-graph-v1:0:none:0:0:0:0:none",
  };
  const response = documentMutationResponse([receipt], snapshot);

  assert.deepEqual(receipt.nodes, { before: 8, after: 0, delta: -8 });
  assert.deepEqual(receipt.edges, { before: 7, after: 0, delta: -7 });
  assert.equal(response.graphRevision, snapshot.graphRevision);
  assert.equal(response.summary.completed, 1);
  assert.equal(response.summary.nodeDelta, -8);
});
