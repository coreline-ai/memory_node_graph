import assert from "node:assert/strict";
import test from "node:test";

import {
  graphApiRequestFromPageUrl,
  graphScopeHistoryStateFromHistoryState,
  historyStateWithGraphScopeState,
  pageUrlForCurrentGraph,
  pageUrlForGraphScope,
  repositoryIdFromNodeId,
} from "../.runtime-dist/app/lib/graph/scope-navigation.js";

test("scope가 없는 일반 그래프 URL은 전체 corpus API를 기본 요청한다", () => {
  const request = graphApiRequestFromPageUrl(
    new URL("http://localhost:3000/?view=constellation&preview=luminosity-v2"),
  );
  assert.equal(request.path, "/api/graph?scope=corpus");
  assert.equal(request.implicitScope, true);
});

test("repository scope와 presentation fixture는 충돌 없이 API로 전달된다", () => {
  const detail = graphApiRequestFromPageUrl(
    new URL("http://localhost:3000/?scope=repository&repositoryId=1322252398&view=orbit"),
  );
  assert.equal(detail.path, "/api/graph?scope=repository&repositoryId=1322252398");
  assert.equal(detail.implicitScope, false);

  const showcase = graphApiRequestFromPageUrl(
    new URL("http://localhost:3000/?scope=repository&repositoryId=1322252398&showcase=max"),
  );
  assert.equal(showcase.path, "/api/graph?showcase=max");
  assert.equal(showcase.implicitScope, false);
});

test("document scope는 문서 ID를 API와 URL에 보존하고 다른 scope 전환 때 정리한다", () => {
  const documentId = "document-559649afa6df34e601c8b4ffcc02151a59ba3e41f46be1f97c76cd8d92f0ad1d";
  const request = graphApiRequestFromPageUrl(
    new URL(`http://localhost:3000/?scope=document&documentId=${documentId}&view=orbit&node=task%3Aone`),
  );
  assert.equal(request.path, `/api/graph?scope=document&documentId=${documentId}`);
  assert.equal(request.implicitScope, false);

  const documentUrl = pageUrlForGraphScope(
    new URL("http://localhost:3000/?scope=repository&repositoryId=1322252398&view=nebula"),
    "document",
    documentId,
  );
  assert.equal(documentUrl.searchParams.get("scope"), "document");
  assert.equal(documentUrl.searchParams.get("documentId"), documentId);
  assert.equal(documentUrl.searchParams.has("repositoryId"), false);
  assert.equal(documentUrl.searchParams.get("view"), "nebula");

  const corpusUrl = pageUrlForGraphScope(documentUrl, "corpus");
  assert.equal(corpusUrl.searchParams.has("documentId"), false);
});

test("scope 전환 URL은 보기·연출 상태를 보존하고 선택·fixture만 정리한다", () => {
  const current = new URL(
    "http://localhost:3000/?view=nebula&preview=luminosity-v2&perf=1&showcase=max&fixture=500x2000&node=old",
  );
  const detail = pageUrlForGraphScope(current, "repository", "1322252398");
  assert.equal(detail.searchParams.get("scope"), "repository");
  assert.equal(detail.searchParams.get("repositoryId"), "1322252398");
  assert.equal(detail.searchParams.get("view"), "nebula");
  assert.equal(detail.searchParams.get("preview"), "luminosity-v2");
  assert.equal(detail.searchParams.get("perf"), "1");
  assert.equal(detail.searchParams.has("showcase"), false);
  assert.equal(detail.searchParams.has("fixture"), false);
  assert.equal(detail.searchParams.has("node"), false);

  const overview = pageUrlForGraphScope(detail, "overview");
  assert.equal(overview.searchParams.get("scope"), "overview");
  assert.equal(overview.searchParams.has("repositoryId"), false);

  const corpus = pageUrlForGraphScope(overview, "corpus");
  assert.equal(corpus.searchParams.get("scope"), "corpus");
  assert.equal(corpus.searchParams.has("repositoryId"), false);
});

test("Gold·최대 밀도 deep link에서 현재 데이터로 돌아오면 fixture node와 궤도 상태를 정리한다", () => {
  const directGold = new URL(
    "http://localhost:3000/?showcase=gold&view=orbit&node=gold%3Aproject%3Amemory-node-graph",
  );
  const defaultReturn = pageUrlForCurrentGraph(directGold, null);
  assert.equal(defaultReturn.searchParams.has("showcase"), false);
  assert.equal(defaultReturn.searchParams.has("fixture"), false);
  assert.equal(defaultReturn.searchParams.get("view"), "constellation");
  assert.equal(defaultReturn.searchParams.has("node"), false);
  assert.equal(defaultReturn.searchParams.get("scope"), "corpus");

  const restored = pageUrlForCurrentGraph(directGold, {
    viewMode: "orbit",
    selectedNodeId: "repository:github:1322252398",
  });
  assert.equal(restored.searchParams.get("view"), "orbit");
  assert.equal(restored.searchParams.get("node"), "repository:github:1322252398");

  const overviewGold = new URL("http://localhost:3000/?scope=overview&showcase=gold");
  assert.equal(pageUrlForCurrentGraph(overviewGold).searchParams.get("scope"), "overview");
});

test("GitHub 저장소 노드 ID만 상세 전환 ID로 허용한다", () => {
  assert.equal(repositoryIdFromNodeId("repository:github:1322252398"), "1322252398");
  assert.equal(repositoryIdFromNodeId("repository:github:0"), null);
  assert.equal(repositoryIdFromNodeId("document:1322252398"), null);
});

test("scope 이력은 선택 노드와 필터를 보존하면서 기존 history state를 유지한다", () => {
  const state = historyStateWithGraphScopeState(
    { appShell: { scrollY: 240 } },
    {
      selectedNodeId: "repository:github:1322252398",
      activeLens: "custom",
      activeDomains: ["agents", "memory", "agents"],
      activeKinds: ["system"],
      activeRelations: ["contains", "contains"],
    },
  );

  assert.deepEqual(state.appShell, { scrollY: 240 });
  assert.deepEqual(graphScopeHistoryStateFromHistoryState(state), {
    selectedNodeId: "repository:github:1322252398",
    activeLens: "custom",
    activeDomains: ["agents", "memory"],
    activeKinds: ["system"],
    activeRelations: ["contains"],
  });
});

test("손상된 scope 이력은 URL 전환을 막지 않고 안전하게 무시한다", () => {
  assert.equal(graphScopeHistoryStateFromHistoryState({}), null);
  assert.equal(graphScopeHistoryStateFromHistoryState({
    aiSystemsAtlasGraphScope: {
      selectedNodeId: 1,
      activeLens: "all",
      activeDomains: [],
      activeKinds: [],
      activeRelations: [],
    },
  }), null);
});
