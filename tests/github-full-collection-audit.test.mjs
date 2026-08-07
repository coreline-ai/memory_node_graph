import assert from "node:assert/strict";
import test from "node:test";

import { auditCollection } from "../scripts/audit-github-full-collection.mjs";

function fixture() {
  return {
    receipt: {
      totals: {
        repositories: 2,
        completed: 1,
        empty: 1,
        blocked: 0,
        failed: 0,
        pending: 0,
        documents: 1,
      },
      repositories: [
        {
          repositoryId: "1",
          repositoryName: "ready-repository",
          status: "completed",
          actualBytes: 100,
          receipt: {
            repositoryId: "1",
            commitSha: "abc",
            fileCount: 1,
            nodeCount: 4,
            edgeCount: 3,
          },
        },
        { repositoryId: "2", repositoryName: "empty-repository", status: "empty" },
      ],
    },
    rows: {
      total: { documents: 1, repositories: 1, bytes: 100, nodes: 4, edges: 3 },
      repositories: [{
        repositoryId: "1",
        documents: 1,
        bytes: 100,
        nodes: 4,
        edges: 3,
        commitCount: 1,
        commitSha: "abc",
      }],
      parserVersions: [{ parserVersion: "parser-2", documents: 1 }],
      integrity: {
        duplicateSourceKeys: 0,
        blocksWithoutDocument: 0,
        mentionsWithoutDocument: 0,
        mentionsWithoutEntity: 0,
        relationsWithoutDocument: 0,
        relationSourcesWithoutEntity: 0,
        relationTargetsWithoutEntity: 0,
        stagingRows: 0,
      },
    },
  };
}

test("전체 수집 영수증과 D1 집계가 일치하면 감사를 통과한다", () => {
  const input = fixture();
  const audit = auditCollection(input.receipt, input.rows);
  assert.equal(audit.passed, true);
  assert.deepEqual(audit.issues, []);
  assert.equal(audit.integrity.repositoryReceiptMismatches, 0);
});

test("저장소별 수량 또는 relation endpoint가 다르면 감사를 실패한다", () => {
  const input = fixture();
  input.rows.repositories[0].edges = 2;
  input.rows.integrity.relationTargetsWithoutEntity = 1;
  const audit = auditCollection(input.receipt, input.rows);
  assert.equal(audit.passed, false);
  assert.match(audit.issues.join("\n"), /ready-repository: 관계 영수증=3, D1=2/);
  assert.match(audit.issues.join("\n"), /relationTargetsWithoutEntity=1/);
});

test("후속 parser 재처리 후에는 원본·commit 무결성을 유지하면서 최초 그래프 수량만 분리해 감사한다", () => {
  const input = fixture();
  input.rows.total.nodes = 40;
  input.rows.total.edges = 52;
  input.rows.repositories[0].nodes = 40;
  input.rows.repositories[0].edges = 52;
  input.rows.parserVersions = [{ parserVersion: "parser-4", documents: 1 }];

  const audit = auditCollection(input.receipt, input.rows, { compareGraphReceipt: false });
  assert.equal(audit.passed, true);
  assert.equal(audit.graphReceiptCompared, false);
  assert.deepEqual(audit.issues, []);

  input.rows.repositories[0].bytes = 99;
  const invalidSource = auditCollection(input.receipt, input.rows, { compareGraphReceipt: false });
  assert.equal(invalidSource.passed, false);
  assert.match(invalidSource.issues.join("\n"), /bytes/);
});
