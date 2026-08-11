import assert from "node:assert/strict";
import test from "node:test";

import {
  GRAPH_CORPUS_EDGE_BUDGET,
  GRAPH_CORPUS_NODE_BUDGET,
  GRAPH_OVERVIEW_EDGE_BUDGET,
  GRAPH_OVERVIEW_NODE_BUDGET,
  GRAPH_REPOSITORY_EDGE_BUDGET,
  GRAPH_REPOSITORY_NODE_BUDGET,
  GRAPH_DOCUMENT_EDGE_BUDGET,
  GRAPH_DOCUMENT_NODE_BUDGET,
  projectGraphCorpus,
  projectGraphDocument,
  projectGraphOverview,
  projectGraphRepository,
} from "../.runtime-dist/app/lib/graph/scope-projection.js";

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

test("corpus 대형 그래프는 녹색 관계 유형을 50~100개 결정적으로 보존한다", () => {
  const nodes = Array.from({ length: 600 }, (_, index) => ({
    ...technology(index),
    id: `concept:diversity:${String(index).padStart(3, "0")}`,
    label: `Diversity concept ${String(index).padStart(3, "0")}`,
    tags: [index < 400 ? "reference-hub" : "delivery-path"],
  }));
  const neutralEdges = nodes.slice(0, 400).flatMap((node, index) =>
    [1, 3, 7, 13, 29, 47]
      .map((offset) => nodes[index + offset])
      .filter((target) => target && Number(target.id.slice(-3)) < 400)
      .map((target) => ({
        source: node.id,
        target: target.id,
        type: "references",
        confidence: 0.99,
        note: "high-degree neutral relation",
        layer: "explicit",
      })));
  const diversityEdges = Array.from({ length: 120 }, (_, index) => ({
    source: nodes[400 + index].id,
    target: nodes[400 + ((index + 41) % 200)].id,
    type: ["uses", "tests", "produces"][index % 3],
    confidence: 0.9,
    note: "green diversity relation",
    layer: "explicit",
  }));
  const snapshot = {
    nodes: [...nodes].reverse(),
    edges: [...neutralEdges, ...diversityEdges].reverse(),
    meta: {
      source: "documents",
      provider: "markdown-ast",
      generatedAt: "2026-08-11T00:00:00Z",
      corpusNodeCount: nodes.length,
      corpusEdgeCount: neutralEdges.length + diversityEdges.length,
    },
  };
  const projected = projectGraphCorpus(snapshot);
  const repeated = projectGraphCorpus({
    ...snapshot,
    nodes: [...snapshot.nodes].reverse(),
    edges: [...snapshot.edges].reverse(),
  });
  const greenEdges = projected.edges.filter((edge) =>
    ["uses", "tests", "produces"].includes(edge.type));

  assert.equal(projected.nodes.length, GRAPH_CORPUS_NODE_BUDGET);
  assert.ok(greenEdges.length >= 50 && greenEdges.length <= 100);
  assert.ok(greenEdges.some((edge) => edge.type === "uses"));
  assert.ok(greenEdges.some((edge) => edge.type === "tests"));
  assert.ok(greenEdges.some((edge) => edge.type === "produces"));
  assert.deepEqual(repeated.nodes, projected.nodes);
  assert.deepEqual(repeated.edges, projected.edges);
});

test("corpus 대형 희소 그래프는 사실 관계를 보존하고 비저장 display weave로 화면 연결을 확장한다", () => {
  const nodes = Array.from({ length: 300 }, (_, index) => ({
    ...technology(index),
    id: `concept:weave:${String(index).padStart(3, "0")}`,
    domain: index % 2 ? "agents" : "memory",
    tags: [index % 3 ? "retrieval" : "orchestration", `cluster-${Math.floor(index / 20)}`],
  }));
  const factualEdges = nodes.flatMap((node, index) => {
    if (index % 20 === 19) return [];
    return [{
      source: node.id,
      target: nodes[index + 1].id,
      type: "supports",
      confidence: 0.9,
      note: "stored relationship",
      layer: "explicit",
    }];
  });
  const snapshot = {
    nodes,
    edges: factualEdges,
    meta: {
      source: "documents",
      provider: "markdown-ast",
      generatedAt: "2026-08-07T00:00:00Z",
      corpusNodeCount: 89_669,
      corpusEdgeCount: 94_488,
    },
  };
  const projected = projectGraphCorpus(snapshot);
  const repeated = projectGraphCorpus({
    ...snapshot,
    nodes: [...nodes].reverse(),
    edges: [...factualEdges].reverse(),
  });
  const projectedFacts = projected.edges.filter((edge) => edge.layer !== "display");
  const displayEdges = projected.edges.filter((edge) => edge.layer === "display");

  assert.deepEqual(projectedFacts, factualEdges);
  assert.ok(displayEdges.length > 0);
  assert.ok(displayEdges.every((edge) =>
    edge.origin === "display"
    && edge.provider === "corpus-visual-weave-v1"
    && /사실 관계로 저장되지 않습니다/.test(edge.note)));
  assert.ok(displayEdges.length <= Math.floor(GRAPH_CORPUS_EDGE_BUDGET * 0.2));
  assert.equal(projected.meta.projectedFactualEdgeCount, factualEdges.length);
  assert.equal(projected.meta.displayEdgeCount, displayEdges.length);
  assert.equal(projected.meta.omittedEdgeCount, 94_488 - factualEdges.length);
  assert.deepEqual(repeated.edges, projected.edges);
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

test("문서 중심 그래프는 직접 언급 노드와 1·2단계 저장 관계만 보여준다", () => {
  const seed = detailNode("concept:document:seed", "Document seed", ["concept", "document"]);
  const first = detailNode("system:document:first", "First hop", ["system"]);
  const second = detailNode("tool:document:second", "Second hop", ["tool"], "tool");
  const third = detailNode("risk:document:third", "Third hop", ["risk"], "risk");
  const edges = [
    { source: seed.id, target: first.id, type: "supports", confidence: 0.98, note: "stored first", layer: "explicit" },
    { source: first.id, target: second.id, type: "depends_on", confidence: 0.94, note: "stored second", layer: "inferred", origin: "codex" },
    { source: second.id, target: third.id, type: "risks", confidence: 0.9, note: "stored third", layer: "explicit" },
    { source: seed.id, target: third.id, type: "related_to", confidence: 0.3, note: "visual only", layer: "display", origin: "display" },
  ];
  const snapshot = {
    nodes: [third, second, first, seed],
    edges: [...edges].reverse(),
    meta: {
      source: "documents",
      provider: "markdown-ast",
      generatedAt: "2026-08-08T00:00:00Z",
      documentId: "document:phase6",
      documentName: "phase-6.md",
      documentSeedNodeIds: [seed.id],
      corpusNodeCount: 89_669,
      corpusEdgeCount: 94_488,
    },
  };
  const projected = projectGraphDocument(snapshot, "document:phase6");
  const repeated = projectGraphDocument({
    ...snapshot,
    nodes: [...snapshot.nodes].reverse(),
    edges: [...snapshot.edges].reverse(),
  }, "document:phase6");

  assert.ok(projected);
  assert.equal(projected.meta.scope, "document");
  assert.equal(projected.meta.projectionMode, "document-evidence-graph");
  assert.equal(projected.meta.nodeBudget, GRAPH_DOCUMENT_NODE_BUDGET);
  assert.equal(projected.meta.edgeBudget, GRAPH_DOCUMENT_EDGE_BUDGET);
  assert.deepEqual(new Set(projected.nodes.map((node) => node.id)), new Set([seed.id, first.id, second.id]));
  assert.equal(projected.nodes.some((node) => node.id === third.id), false);
  assert.equal(projected.edges.length, 2);
  assert.ok(projected.edges.every((edge) => edge.layer !== "display"));
  assert.equal(projected.meta.displayEdgeCount, 0);
  assert.equal(projected.meta.projectedFactualEdgeCount, 2);
  assert.deepEqual(repeated.nodes, projected.nodes);
  assert.deepEqual(repeated.edges, projected.edges);
  assert.equal(projectGraphDocument(snapshot, "document:missing"), null);
});
