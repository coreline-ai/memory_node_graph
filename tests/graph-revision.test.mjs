import assert from "node:assert/strict";
import test from "node:test";

import {
  GRAPH_REVISION_STORAGE_KEY,
  graphRevisionFromState,
  shouldRefreshGraphRevision,
} from "../.runtime-dist/app/lib/graph/graph-revision.js";

const state = {
  documents: 854,
  documentVersion: "2026-08-07T13:00:00.000Z",
  entities: 89_677,
  mentions: 99_401,
  relations: 94_495,
  relationVersion: 94_495,
  relationUpdatedAt: "2026-08-07T13:00:00.000Z",
};

test("graph revision은 같은 저장 상태에 결정적이고 그래프 변화에 반응한다", () => {
  const current = graphRevisionFromState(state);
  assert.equal(current, graphRevisionFromState({ ...state }));
  assert.notEqual(current, graphRevisionFromState({ ...state, mentions: state.mentions + 1 }));
  assert.notEqual(current, graphRevisionFromState({
    ...state,
    relationUpdatedAt: "2026-08-07T13:00:01.000Z",
  }));
  assert.notEqual(current, graphRevisionFromState({
    ...state,
    documentVersion: "2026-08-07T13:00:01.000Z",
  }));
});

test("자동 갱신은 초기 상태나 동일 revision을 무시하고 실제 변경만 다시 읽는다", () => {
  const current = graphRevisionFromState(state);
  const next = graphRevisionFromState({ ...state, relations: state.relations + 1 });
  assert.equal(shouldRefreshGraphRevision("", next), false);
  assert.equal(shouldRefreshGraphRevision(current, current), false);
  assert.equal(shouldRefreshGraphRevision(current, next), true);
  assert.equal(GRAPH_REVISION_STORAGE_KEY, "ai-systems-atlas:graph-revision");
});
