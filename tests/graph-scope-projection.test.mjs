import assert from "node:assert/strict";
import test from "node:test";

import {
  GRAPH_CORPUS_EDGE_BUDGET,
  GRAPH_CORPUS_NODE_BUDGET,
  GRAPH_OVERVIEW_EDGE_BUDGET,
  GRAPH_OVERVIEW_NODE_BUDGET,
  GRAPH_REPOSITORY_EDGE_BUDGET,
  GRAPH_REPOSITORY_NODE_BUDGET,
  projectGraphCorpus,
  projectGraphOverview,
  projectGraphRepository,
} from "../.connector-dist/app/lib/graph/scope-projection.js";

const repository = (index) => ({
  id: `repository:github:${1000 + index}`,
  label: `Repository ${String(index).padStart(3, "0")}`,
  shortLabel: `Repo ${index}`,
  kind: "system",
  domain: "infrastructure",
  summary: "GitHub repository",
  insight: "fixture",
  tags: ["repository", "github", "coreline-ai"],
});
const technology = (index) => ({
  id: `technology:${String(index).padStart(3, "0")}`,
  label: `Technology ${String(index).padStart(3, "0")}`,
  shortLabel: `Tech ${index}`,
  kind: "tool",
  domain: "infrastructure",
  summary: "Shared technology",
  insight: "fixture",
  tags: ["technology", "shared"],
});

test("corpus는 실제 관계의 고연결 이웃을 결정적으로 500/2000 예산에 투영한다", () => {
  const repositories = Array.from({ length: 30 }, (_, index) => repository(index));
  const concepts = Array.from({ length: 570 }, (_, index) => ({
    ...technology(index),
    id: `concept:corpus:${String(index).padStart(3, "0")}`,
    label: `Corpus concept ${String(index).padStart(3, "0")}`,
    tags: [index % 3 === 0 ? "api" : index % 3 === 1 ? "risk" : "component"],
  }));
  const nodes = [...repositories, ...concepts];
  const edges = nodes.flatMap((node, index) =>
    [1, 2, 3, 5, 8, 13, 21, 34]
      .map((offset) => nodes[index + offset])
      .filter(Boolean)
      .map((target, edgeIndex) => ({
        source: node.id,
        target: target.id,
        type: edgeIndex % 2 ? "supports" : "depends_on",
        confidence: 0.8 + edgeIndex / 100,
        note: "stored relationship",
        layer: edgeIndex % 3 ? "explicit" : "structural",
      })));
  const snapshot = {
    nodes: [...nodes].reverse(),
    edges: [...edges].reverse(),
    meta: {
      source: "documents",
      provider: "markdown-ast",
      generatedAt: "2026-08-07T00:00:00Z",
      documentCount: 853,
      repositoryCount: 111,
      corpusNodeCount: 89_669,
      corpusEdgeCount: 94_488,
    },
  };
  const projected = projectGraphCorpus(snapshot);
  const repeated = projectGraphCorpus({
    ...snapshot,
    nodes: [...snapshot.nodes].reverse(),
    edges: [...snapshot.edges].reverse(),
  });

  assert.equal(projected.nodes.length, GRAPH_CORPUS_NODE_BUDGET);
  assert.equal(projected.edges.length, GRAPH_CORPUS_EDGE_BUDGET);
  assert.equal(projected.meta.scope, "corpus");
  assert.equal(projected.meta.projectionMode, "full-corpus-knowledge-map");
  assert.equal(projected.meta.corpusNodeCount, 89_669);
  assert.equal(projected.meta.corpusEdgeCount, 94_488);
  assert.equal(projected.meta.omittedNodeCount, 89_669 - GRAPH_CORPUS_NODE_BUDGET);
  assert.equal(projected.meta.omittedEdgeCount, 94_488 - GRAPH_CORPUS_EDGE_BUDGET);
  assert.ok(projected.nodes.filter((node) => node.id.startsWith("repository:github:")).length <= 24);
  const selectedIds = new Set(projected.nodes.map((node) => node.id));
  assert.ok(projected.edges.every((edge) => selectedIds.has(edge.source) && selectedIds.has(edge.target)));
  assert.ok(projected.edges.every((edge) => edge.note === "stored relationship"));
  assert.deepEqual(repeated.nodes, projected.nodes);
  assert.deepEqual(repeated.edges, projected.edges);
});

test("corpus 소형 그래프는 임의 관계를 만들지 않는다", () => {
  const nodes = [repository(0), technology(0), technology(1)];
  const edges = [{
    source: nodes[0].id,
    target: nodes[1].id,
    type: "uses",
    confidence: 0.9,
    note: "one fact",
  }];
  const projected = projectGraphCorpus({
    nodes,
    edges,
    meta: { source: "documents", provider: "markdown-ast", generatedAt: "now" },
  });
  assert.equal(projected.nodes.length, 3);
  assert.deepEqual(projected.edges, edges);
});

test("overview는 모든 저장소를 우선하고 공유 기술을 결정적으로 500노드 예산에 맞춘다", () => {
  const repositories = Array.from({ length: 3 }, (_, index) => repository(index));
  const technologies = Array.from({ length: 510 }, (_, index) => technology(index));
  const ignoredDocument = {
    ...repository(999),
    id: "document:ignored",
    label: "README.md",
    tags: ["document", "github-readme"],
  };
  const edges = technologies.flatMap((node, index) => [{
    source: repositories[index % repositories.length].id,
    target: node.id,
    type: "uses",
    confidence: 0.9,
    note: "technology",
  }]);
  edges.push(
    { source: repositories[1].id, target: technologies[0].id, type: "uses", confidence: 0.99, note: "shared" },
    { source: repositories[2].id, target: technologies[0].id, type: "uses", confidence: 0.99, note: "shared" },
    { source: repositories[1].id, target: technologies[1].id, type: "uses", confidence: 0.98, note: "shared" },
    {
      source: repositories[0].id,
      target: technologies[0].id,
      type: "uses",
      confidence: 0.91,
      note: "duplicate",
      evidence: [{
        blockId: "block:overview:readme",
        explanation: "repository technology",
        sourceUrl: `https://github.com/coreline-ai/repository-000/blob/${"a".repeat(40)}/README.md#L5`,
      }],
    },
  );
  const snapshot = {
    nodes: [...technologies, ignoredDocument, ...repositories].reverse(),
    edges: [...edges].reverse(),
    meta: {
      source: "documents",
      provider: "markdown-ast",
      generatedAt: "2026-08-04T12:00:00.000Z",
      documentCount: 514,
    },
  };
  const overview = projectGraphOverview(snapshot);
  const repeated = projectGraphOverview({ ...snapshot, nodes: [...snapshot.nodes].reverse(), edges: [...snapshot.edges].reverse() });

  assert.equal(overview.nodes.length, GRAPH_OVERVIEW_NODE_BUDGET);
  assert.equal(overview.meta.scope, "overview");
  assert.equal(overview.meta.repositoryCount, 3);
  assert.equal(overview.meta.totalNodeCount, 513);
  assert.equal(overview.meta.omittedNodeCount, 13);
  assert.equal(overview.meta.edgeBudget, GRAPH_OVERVIEW_EDGE_BUDGET);
  assert.ok(repositories.every((node) => overview.nodes.some((item) => item.id === node.id)));
  assert.ok(overview.nodes.some((node) => node.id === technologies[0].id));
  assert.ok(overview.nodes.some((node) => node.id === technologies[1].id));
  assert.ok(overview.nodes.every((node) => !node.id.startsWith("document:")));
  assert.ok(overview.edges.every((edge) =>
    overview.nodes.some((node) => node.id === edge.source)
    && overview.nodes.some((node) => node.id === edge.target)));
  assert.deepEqual(repeated.nodes, overview.nodes);
  assert.deepEqual(repeated.edges, overview.edges);
  assert.equal(overview.edges.filter((edge) =>
    edge.source === repositories[0].id && edge.target === technologies[0].id).length, 1);
  assert.equal(
    overview.nodes.find((node) => node.id === repositories[0].id)?.source?.relativePath,
    "README.md",
  );

  const edgeLimited = projectGraphOverview(snapshot, { edgeBudget: 10 });
  assert.equal(edgeLimited.edges.length, 10);
  assert.equal(edgeLimited.meta.omittedEdgeCount, edgeLimited.meta.totalEdgeCount - 10);
});

test("overview는 GitHub 저장소가 없으면 데모 개념 대신 빈 안내 상태를 반환한다", () => {
  const overview = projectGraphOverview({
    nodes: [technology(1)],
    edges: [],
    meta: {
      source: "demo",
      provider: "built-in",
      generatedAt: "2026-08-04T12:00:00.000Z",
    },
  });
  assert.equal(overview.nodes.length, 0);
  assert.equal(overview.meta.repositoryCount, 0);
  assert.match(overview.meta.message, /동기화된 GitHub 저장소가 없습니다/);
});

const detailNode = (id, label, tags, kind = "system") => ({
  id,
  label,
  shortLabel: label,
  kind,
  domain: "infrastructure",
  summary: label,
  insight: "fixture",
  tags,
});

const lineEvidence = (path, line) => [{
  blockId: `block:${path}:${line}`,
  explanation: "fixture source",
  sourceUrl: `https://github.com/coreline-ai/repository-000/blob/${"b".repeat(40)}/${path}#L${line}`,
}];

test("repository 상세는 선택 저장소의 README·Plan·Phase·Task만 결정적으로 투영한다", () => {
  const selectedRepository = repository(0);
  const otherRepository = repository(1);
  const readme = detailNode("document:readme", "README.md", ["document", "github-readme", "README.md"]);
  const planDocument = detailNode("document:plan", "dev-plan/implement.md", ["document", "github-dev-plan", "dev-plan/implement.md"]);
  const plan = detailNode("plan:github:1000:implement", "Implementation plan", ["plan", "github-dev-plan"]);
  const readmeSection = detailNode("section:readme:overview", "Overview", ["section", "github-readme", "purpose"], "concept");
  const phase = detailNode("phase:plan:one", "Phase 1", ["section", "github-dev-plan", "phase"]);
  const completedTask = detailNode("task:plan:complete", "Completed task", ["task", "github-dev-plan", "completed"], "practice");
  const pendingTask = detailNode("task:plan:pending", "Pending task", ["task", "github-dev-plan", "pending"], "practice");
  const sharedTechnology = technology(0);
  const sharedReference = detailNode("reference:docs", "Reference", ["reference", "url", "shared"], "tool");
  const otherDocument = detailNode("document:other", "README.md", ["document", "github-readme", "README.md"]);
  const otherTask = detailNode("task:other", "Other repository task", ["task", "pending"], "practice");
  const disconnectedManual = detailNode("document:manual", "manual.md", ["document", "generic"]);
  const edges = [
    { source: selectedRepository.id, target: readme.id, type: "documents", confidence: 0.99, note: "readme", evidence: lineEvidence("README.md", 1) },
    { source: selectedRepository.id, target: planDocument.id, type: "documents", confidence: 0.99, note: "plan document" },
    { source: selectedRepository.id, target: plan.id, type: "plans", confidence: 0.99, note: "plan" },
    { source: plan.id, target: planDocument.id, type: "documents", confidence: 0.99, note: "source" },
    { source: readme.id, target: readmeSection.id, type: "contains", confidence: 0.98, note: "heading" },
    { source: plan.id, target: phase.id, type: "contains", confidence: 0.98, note: "phase" },
    { source: phase.id, target: completedTask.id, type: "contains", confidence: 0.99, note: "task" },
    { source: phase.id, target: pendingTask.id, type: "contains", confidence: 0.99, note: "task", evidence: lineEvidence("dev-plan/implement.md", 42) },
    { source: selectedRepository.id, target: sharedTechnology.id, type: "uses", confidence: 0.96, note: "technology" },
    { source: readme.id, target: sharedReference.id, type: "uses", confidence: 0.95, note: "reference" },
    { source: otherRepository.id, target: otherDocument.id, type: "documents", confidence: 0.99, note: "other readme" },
    { source: otherDocument.id, target: otherTask.id, type: "contains", confidence: 0.99, note: "other task" },
    { source: otherRepository.id, target: sharedTechnology.id, type: "uses", confidence: 0.96, note: "shared technology" },
    { source: sharedTechnology.id, target: otherRepository.id, type: "supports", confidence: 0.8, note: "must not cross" },
  ];
  const snapshot = {
    nodes: [
      disconnectedManual,
      otherTask,
      otherDocument,
      sharedReference,
      sharedTechnology,
      pendingTask,
      completedTask,
      phase,
      readmeSection,
      plan,
      planDocument,
      readme,
      otherRepository,
      selectedRepository,
    ].reverse(),
    edges: [...edges].reverse(),
    meta: {
      source: "documents",
      provider: "markdown-ast",
      generatedAt: "2026-08-04T12:00:00.000Z",
      documentCount: 4,
    },
  };
  const detail = projectGraphRepository(snapshot, "1000");
  const repeated = projectGraphRepository({
    ...snapshot,
    nodes: [...snapshot.nodes].reverse(),
    edges: [...snapshot.edges].reverse(),
  }, "1000");

  assert.ok(detail);
  assert.equal(detail.meta.scope, "repository");
  assert.equal(detail.meta.repositoryId, "1000");
  assert.equal(detail.meta.repositoryCount, 1);
  assert.equal(detail.meta.documentCount, 2);
  assert.equal(detail.meta.nodeBudget, GRAPH_REPOSITORY_NODE_BUDGET);
  assert.equal(detail.meta.edgeBudget, GRAPH_REPOSITORY_EDGE_BUDGET);
  assert.ok([readme, planDocument, plan, readmeSection, phase, completedTask, pendingTask]
    .every((node) => detail.nodes.some((item) => item.id === node.id)));
  assert.ok(detail.nodes.some((node) => node.id === sharedTechnology.id));
  assert.ok(detail.nodes.some((node) => node.id === sharedReference.id));
  assert.ok(detail.nodes.every((node) => ![otherRepository.id, otherDocument.id, otherTask.id, disconnectedManual.id].includes(node.id)));
  assert.ok(detail.edges.every((edge) =>
    detail.nodes.some((node) => node.id === edge.source)
    && detail.nodes.some((node) => node.id === edge.target)));
  assert.deepEqual(repeated.nodes, detail.nodes);
  assert.deepEqual(repeated.edges, detail.edges);
  assert.equal(detail.nodes.find((node) => node.id === selectedRepository.id)?.source?.relativePath, "README.md");
  assert.equal(detail.nodes.find((node) => node.id === pendingTask.id)?.source?.relativePath, "dev-plan/implement.md");

  const limited = projectGraphRepository(snapshot, "1000", { nodeBudget: 7, edgeBudget: 4 });
  assert.ok(limited);
  assert.equal(limited.nodes.length, 7);
  assert.equal(limited.edges.length, 4);
  assert.ok(limited.nodes.some((node) => node.tags.includes("shared")));
  assert.equal(limited.meta.omittedNodeCount, limited.meta.totalNodeCount - 7);
  assert.equal(limited.meta.omittedEdgeCount, limited.meta.totalEdgeCount - 4);
});

test("단일 저장소 overview는 저장소 한 점이 아니라 내부 문서·의미 노드·커뮤니티 브리지를 투영한다", () => {
  const repositoryNode = repository(0);
  const documents = Array.from({ length: 8 }, (_, index) => detailNode(
    `document:single:${index}`,
    index === 0 ? "README.md" : `dev-plan/phase-${index}.md`,
    ["document", index === 0 ? "github-readme" : "github-dev-plan"],
  ));
  const semantic = Array.from({ length: 80 }, (_, index) => detailNode(
    `semantic:single:${index}`,
    `Semantic ${index}`,
    [index % 4 === 0 ? "technology" : index % 4 === 1 ? "api" : index % 4 === 2 ? "risk" : "task"],
    index % 4 === 2 ? "risk" : "concept",
  ));
  const edges = [
    ...documents.map((document) => ({
      source: repositoryNode.id,
      target: document.id,
      type: "documents",
      confidence: 1,
      note: "문서",
      layer: "structural",
    })),
    ...semantic.map((node, index) => ({
      source: documents[index % documents.length].id,
      target: node.id,
      type: index % 3 === 0 ? "mentions" : "supports",
      confidence: 0.9,
      note: "의미",
      layer: "explicit",
      evidence: lineEvidence(index % 2 ? "README.md" : "dev-plan/phase.md", index + 1),
    })),
    ...semantic.slice(0, -1).map((node, index) => ({
      source: node.id,
      target: semantic[index + 1].id,
      type: "depends_on",
      confidence: 0.86,
      note: "교차 관계",
      layer: "explicit",
    })),
  ];
  const snapshot = {
    nodes: [repositoryNode, ...documents, ...semantic],
    edges,
    meta: { source: "documents", provider: "markdown-ast", generatedAt: "2026-08-06T00:00:00Z", documentCount: 8 },
  };
  const overview = projectGraphOverview(snapshot);
  const repeated = projectGraphOverview({ ...snapshot, nodes: [...snapshot.nodes].reverse(), edges: [...snapshot.edges].reverse() });
  assert.equal(overview.meta.projectionMode, "single-repository-knowledge-map");
  assert.equal(overview.meta.repositoryCount, 1);
  assert.ok(overview.nodes.length >= 60);
  assert.ok(overview.edges.length > overview.nodes.length);
  assert.ok(overview.nodes.some((node) => node.tags.includes("api")));
  assert.ok(overview.nodes.some((node) => node.tags.includes("risk")));
  assert.ok(overview.edges.some((edge) => edge.layer === "display"));
  assert.deepEqual(repeated.nodes, overview.nodes);
  assert.deepEqual(repeated.edges, overview.edges);
});

test("repository 상세는 존재하지 않는 저장소를 null로 구분한다", () => {
  const snapshot = {
    nodes: [repository(0)],
    edges: [],
    meta: {
      source: "documents",
      provider: "markdown-ast",
      generatedAt: "2026-08-04T12:00:00.000Z",
      documentCount: 1,
    },
  };
  assert.equal(projectGraphRepository(snapshot, "9999"), null);
});

test("repository 상세는 대형 저장소도 기본 500노드·2,000관계 예산을 지킨다", () => {
  const repositoryNode = repository(0);
  const documentNode = detailNode("document:large-plan", "dev-plan/large.md", ["document", "github-dev-plan"]);
  const phaseNode = detailNode("phase:large", "Phase Large", ["section", "github-dev-plan", "phase"]);
  const tasks = Array.from({ length: 520 }, (_, index) => detailNode(
    `task:large:${String(index).padStart(3, "0")}`,
    `Task ${String(index).padStart(3, "0")}`,
    ["task", "github-dev-plan", index % 2 ? "pending" : "completed"],
    "practice",
  ));
  const structuralEdges = [
    { source: repositoryNode.id, target: documentNode.id, type: "documents", confidence: 0.99, note: "plan" },
    { source: documentNode.id, target: phaseNode.id, type: "contains", confidence: 0.99, note: "phase" },
    ...tasks.map((task) => ({
      source: phaseNode.id,
      target: task.id,
      type: "contains",
      confidence: 0.99,
      note: "task",
    })),
  ];
  const denseEdges = tasks.flatMap((task, index) =>
    [1, 2, 3, 4]
      .map((offset) => tasks[index + offset])
      .filter(Boolean)
      .map((target) => ({
        source: task.id,
        target: target.id,
        type: "supports",
        confidence: 0.8,
        note: "dependency",
      })));
  const detail = projectGraphRepository({
    nodes: [repositoryNode, documentNode, phaseNode, ...tasks].reverse(),
    edges: [...structuralEdges, ...denseEdges].reverse(),
    meta: {
      source: "documents",
      provider: "markdown-ast",
      generatedAt: "2026-08-04T12:00:00.000Z",
      documentCount: 1,
    },
  }, "1000");

  assert.ok(detail);
  assert.equal(detail.nodes.length, GRAPH_REPOSITORY_NODE_BUDGET);
  assert.equal(detail.edges.length, GRAPH_REPOSITORY_EDGE_BUDGET);
  assert.equal(detail.meta.totalNodeCount, 523);
  assert.equal(detail.meta.documentCount, 1);
  assert.equal(detail.meta.omittedNodeCount, 23);
  assert.equal(detail.meta.omittedEdgeCount, detail.meta.totalEdgeCount - GRAPH_REPOSITORY_EDGE_BUDGET);
  assert.ok(detail.nodes.some((node) => node.id === documentNode.id));
  assert.ok(detail.nodes.some((node) => node.id === phaseNode.id));
  assert.ok(detail.edges.every((edge) =>
    detail.nodes.some((node) => node.id === edge.source)
    && detail.nodes.some((node) => node.id === edge.target)));
});
