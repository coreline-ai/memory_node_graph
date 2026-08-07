import assert from "node:assert/strict";
import test from "node:test";

import { createGraphSnapshotCache } from "../.connector-dist/app/lib/graph/snapshot-cache.js";

const snapshot = (label) => ({
  nodes: [{
    id: "node:one",
    label,
    shortLabel: label,
    kind: "concept",
    domain: "reasoning",
    summary: label,
    insight: label,
    tags: ["fixture"],
  }],
  edges: [],
  meta: {
    source: "documents",
    provider: "markdown-ast",
    generatedAt: "2026-08-07T00:00:00.000Z",
  },
});

test("같은 fingerprint의 동시·반복 요청은 한 번만 읽고 독립 snapshot을 반환한다", async () => {
  const cache = createGraphSnapshotCache();
  let loads = 0;
  const load = async () => {
    loads += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return snapshot("first");
  };
  const [first, concurrent] = await Promise.all([
    cache.get("fingerprint-1", load),
    cache.get("fingerprint-1", load),
  ]);
  first.nodes[0].label = "mutated";
  first.nodes[0].tags.push("changed");
  const repeated = await cache.get("fingerprint-1", load);

  assert.equal(loads, 1);
  assert.equal(concurrent.nodes[0].label, "first");
  assert.equal(repeated.nodes[0].label, "first");
  assert.deepEqual(repeated.nodes[0].tags, ["fixture"]);
});

test("fingerprint 변경과 clear는 후보 snapshot을 다시 읽는다", async () => {
  const cache = createGraphSnapshotCache();
  let loads = 0;
  const load = async () => snapshot(`load-${++loads}`);

  assert.equal((await cache.get("one", load)).nodes[0].label, "load-1");
  assert.equal((await cache.get("two", load)).nodes[0].label, "load-2");
  cache.clear();
  assert.equal((await cache.get("two", load)).nodes[0].label, "load-3");
});

test("실패한 load는 cache에 남지 않아 같은 fingerprint를 재시도할 수 있다", async () => {
  const cache = createGraphSnapshotCache();
  let loads = 0;
  await assert.rejects(cache.get("retry", async () => {
    loads += 1;
    throw new Error("temporary failure");
  }), /temporary failure/);
  const recovered = await cache.get("retry", async () => {
    loads += 1;
    return snapshot("recovered");
  });
  assert.equal(loads, 2);
  assert.equal(recovered.nodes[0].label, "recovered");
});
