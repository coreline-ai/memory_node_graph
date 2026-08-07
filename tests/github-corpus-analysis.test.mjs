import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { analyzeCorpusDatabase, classifyCorpusBlock } from "../scripts/analyze-github-corpus.mjs";

test("코퍼스 블록 분류는 문서 골격과 의미 후보를 구분한다", () => {
  assert.equal(classifyCorpusBlock({ type: "document", text: "README" }).primary, "document-root");
  assert.equal(classifyCorpusBlock({ type: "heading", text: "구현 태스크" }).primary, "boilerplate");
  assert.equal(classifyCorpusBlock({ type: "paragraph", text: "현재 아키텍처는 Worker와 D1으로 구성됩니다." }).primary, "current-architecture");
  assert.equal(classifyCorpusBlock({ type: "listItem", text: "위험: Lease 만료 시 이전 상태를 보존합니다." }).primary, "risk");
  assert.equal(classifyCorpusBlock({ type: "paragraph", text: "별도의 의미 신호가 없는 일반 문장입니다." }).primary, "ambiguous");
});

test("전체 코퍼스 분석은 모든 문서·블록을 읽고 D1을 변경하지 않는다", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE documents (
      id TEXT PRIMARY KEY, source_type TEXT, repository_id TEXT, repository_name TEXT,
      relative_path TEXT, commit_sha TEXT, hash TEXT, size INTEGER,
      node_count INTEGER, edge_count INTEGER, parser_version TEXT
    );
    CREATE TABLE document_blocks (
      id TEXT PRIMARY KEY, document_id TEXT, type TEXT, depth INTEGER,
      text TEXT, ordinal INTEGER, source_url TEXT
    );
    CREATE TABLE entities (id TEXT PRIMARY KEY, label TEXT, kind TEXT, domain TEXT);
    CREATE TABLE relations (id TEXT PRIMARY KEY, document_id TEXT, source_id TEXT, target_id TEXT, type TEXT);
    CREATE TABLE entity_mentions (id TEXT PRIMARY KEY, document_id TEXT, entity_id TEXT);
    CREATE TABLE enrichment_jobs (id TEXT PRIMARY KEY);
    INSERT INTO documents VALUES
      ('d1','github','1','atlas','README.md','abc','hash-readme',100,2,1,'readme-2'),
      ('d2','github','1','atlas','dev-plan/plan.md','abc','hash-plan',120,2,1,'dev-plan-2');
    INSERT INTO document_blocks VALUES
      ('b1','d1','document',0,'README',0,'https://github.com/coreline-ai/atlas/blob/abc/README.md#L1'),
      ('b2','d1','heading',1,'현재 아키텍처',1,'https://github.com/coreline-ai/atlas/blob/abc/README.md#L2'),
      ('b3','d2','document',0,'plan',0,'https://github.com/coreline-ai/atlas/blob/abc/dev-plan/plan.md#L1'),
      ('b4','d2','heading',1,'구현 태스크',1,'https://github.com/coreline-ai/atlas/blob/abc/dev-plan/plan.md#L2');
    INSERT INTO entities VALUES
      ('repo','atlas','system','reasoning'),
      ('doc1','README','system','reasoning'),
      ('tech','TypeScript','tool','reasoning');
    INSERT INTO relations VALUES
      ('r1','d1','repo','doc1','documents'),
      ('r2','d1','doc1','tech','uses');
    INSERT INTO entity_mentions VALUES
      ('m1','d1','tech'),
      ('m2','d2','tech');
  `);

  const { snapshot, analysis } = analyzeCorpusDatabase(database);
  assert.equal(snapshot.documents.length, 2);
  assert.equal(analysis.corpus.documents, 2);
  assert.equal(analysis.blocks.total, 4);
  assert.equal(analysis.blocks.contentBlocks, 2);
  assert.equal(analysis.blocks.classifications["current-architecture"], 1);
  assert.equal(analysis.blocks.classifications.boilerplate, 1);
  assert.equal(analysis.graph.entities, 3);
  assert.equal(analysis.graph.relations, 2);
  assert.equal(analysis.graph.danglingSources, 0);
  assert.equal(analysis.graph.danglingTargets, 0);
  assert.equal(analysis.audit.readOnlyPreserved, true);
  assert.equal(analysis.audit.completeCoverage, true);
  assert.equal(analysis.goldGraphCandidates.length, 2);
  const repeated = analyzeCorpusDatabase(database);
  assert.equal(repeated.analysis.snapshotDigest, analysis.snapshotDigest);
  assert.deepEqual(repeated.analysis.blocks.classifications, analysis.blocks.classifications);
  assert.throws(() => database.exec("INSERT INTO enrichment_jobs VALUES ('mutated')"), /readonly/i);
  database.close();
});
