import assert from "node:assert/strict";
import test from "node:test";

import {
  countDashboardDocumentsBySource,
  filterDashboardDocumentsBySource,
} from "../.runtime-dist/app/lib/dashboard/document-source-filter.js";

const documents = [
  { id: "manual-guide", sourceType: "manual", sourceLabel: "수동 업로드" },
  { id: "github-readme", sourceType: "github", sourceLabel: "atlas · README.md" },
  { id: "github-plan", sourceType: "github", sourceLabel: "atlas · dev-plan/implement.md" },
];

test("대시보드 문서 출처 집계는 전체·수동 업로드·GitHub 동기화를 함께 제공한다", () => {
  assert.deepEqual(countDashboardDocumentsBySource(documents), {
    all: 3,
    manual: 1,
    github: 2,
  });
});

test("대시보드 문서 출처 filter는 원본 순서를 보존하고 입력 배열을 변경하지 않는다", () => {
  const originalIds = documents.map((document) => document.id);

  assert.deepEqual(
    filterDashboardDocumentsBySource(documents, "github").map((document) => document.id),
    ["github-readme", "github-plan"],
  );
  assert.deepEqual(
    filterDashboardDocumentsBySource(documents, "manual").map((document) => document.id),
    ["manual-guide"],
  );
  assert.notStrictEqual(filterDashboardDocumentsBySource(documents, "all"), documents);
  assert.deepEqual(documents.map((document) => document.id), originalIds);
});
