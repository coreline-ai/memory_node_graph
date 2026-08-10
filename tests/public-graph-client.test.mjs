import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  loadPublicGraphSnapshot,
  loadPublicGoldGraphSnapshot,
  PUBLIC_GOLD_CHECKSUM_PATH,
  PUBLIC_GOLD_SNAPSHOT_PATH,
  PUBLIC_GRAPH_MANIFEST_PATH,
  PUBLIC_GRAPH_SNAPSHOT_PATH,
  validatePublicGoldGraphSnapshot,
  validatePublicGraphSnapshot,
} from "../.runtime-dist/app/lib/graph/public-graph-client.js";

const snapshot = {
  schemaVersion: "atlas-public-graph/v1",
  nodes: [
    {
      id: "pub_111111111111111111111111",
      label: "Public node one",
      shortLabel: "Node one",
      kind: "concept",
      domain: "reasoning",
      summary: "Public summary",
      insight: "Public insight",
      tags: ["public"],
    },
    {
      id: "pub_222222222222222222222222",
      label: "Public node two",
      shortLabel: "Node two",
      kind: "system",
      domain: "infrastructure",
      summary: "Public summary",
      insight: "Public insight",
      tags: ["public"],
    },
  ],
  edges: [
    {
      source: "pub_111111111111111111111111",
      target: "pub_222222222222222222222222",
      type: "supports",
      confidence: 0.91,
      note: "Public relation",
      layer: "explicit",
      origin: "rule",
    },
  ],
  meta: {
    source: "documents",
    provider: "markdown-ast",
    generatedAt: "2026-08-10T00:00:00.000Z",
    scope: "corpus",
    publicSnapshot: true,
    projectedFactualEdgeCount: 1,
    displayEdgeCount: 0,
  },
};

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

const createFixture = (snapshotText = json(snapshot)) => {
  const hash = createHash("sha256").update(snapshotText).digest("hex");
  const manifestText = json({
    schemaVersion: "atlas-public-graph-manifest/v1",
    snapshotPath: PUBLIC_GRAPH_SNAPSHOT_PATH,
    snapshotSha256: hash,
    counts: {
      projectedNodes: snapshot.nodes.length,
      projectedFactualEdges: 1,
      displayEdges: 0,
      projectedLines: snapshot.edges.length,
    },
  });
  const calls = [];
  const fetchGraph = async (path) => {
    calls.push(path);
    const body = path === PUBLIC_GRAPH_SNAPSHOT_PATH
      ? snapshotText
      : path === PUBLIC_GRAPH_MANIFEST_PATH
        ? manifestText
        : "";
    return new Response(body, { status: body ? 200 : 404 });
  };
  return { fetchGraph, calls };
};

test("공개 client는 정적 snapshot과 manifest만 요청하고 SHA·수량을 검증한다", async () => {
  const fixture = createFixture();
  const result = await loadPublicGraphSnapshot(fixture.fetchGraph);
  assert.deepEqual(fixture.calls.sort(), [
    PUBLIC_GRAPH_MANIFEST_PATH,
    PUBLIC_GRAPH_SNAPSHOT_PATH,
  ].sort());
  assert.equal(fixture.calls.some((path) => path.startsWith("/api/")), false);
  assert.equal(result.snapshot.nodes.length, 2);
  assert.equal(result.snapshot.edges.length, 1);
  assert.equal(result.snapshot.meta.publicSnapshot, true);
});

test("snapshot 변조는 manifest SHA와 달라 공개 client에서 차단된다", async () => {
  const validFixture = createFixture();
  const validSnapshotResponse = await validFixture.fetchGraph(PUBLIC_GRAPH_SNAPSHOT_PATH);
  const originalText = await validSnapshotResponse.text();
  const tamperedText = originalText.replace("Public summary", "Tampered summary");
  const originalHash = createHash("sha256").update(originalText).digest("hex");
  const manifestText = json({
    schemaVersion: "atlas-public-graph-manifest/v1",
    snapshotPath: PUBLIC_GRAPH_SNAPSHOT_PATH,
    snapshotSha256: originalHash,
    counts: { projectedNodes: 2, projectedFactualEdges: 1, displayEdges: 0, projectedLines: 1 },
  });
  await assert.rejects(
    loadPublicGraphSnapshot(async (path) => new Response(
      path === PUBLIC_GRAPH_SNAPSHOT_PATH ? tamperedText : manifestText,
      { status: 200 },
    )),
    /SHA-256/,
  );
});

test("orphan edge와 공개 meta 위반을 차단한다", () => {
  assert.throws(
    () => validatePublicGraphSnapshot({
      ...snapshot,
      edges: [{ ...snapshot.edges[0], target: "pub_333333333333333333333333" }],
    }),
    /연결 대상/,
  );
  assert.throws(
    () => validatePublicGraphSnapshot({
      ...snapshot,
      meta: { ...snapshot.meta, publicSnapshot: false },
    }),
    /meta 계약/,
  );
});

test("공개 Gold client는 정적 JSON·checksum만 요청하고 68노드·101관계를 검증한다", async () => {
  const [snapshotText, checksumText] = await Promise.all([
    readFile(new URL("../public/atlas/atlas-gold-snapshot.json", import.meta.url), "utf8"),
    readFile(new URL("../public/atlas/atlas-gold-snapshot.sha256", import.meta.url), "utf8"),
  ]);
  const calls = [];
  const graph = await loadPublicGoldGraphSnapshot(async (path) => {
    calls.push(path);
    const body = path === PUBLIC_GOLD_SNAPSHOT_PATH
      ? snapshotText
      : path === PUBLIC_GOLD_CHECKSUM_PATH
        ? checksumText
        : "";
    return new Response(body, { status: body ? 200 : 404 });
  });

  assert.deepEqual(calls.sort(), [
    PUBLIC_GOLD_CHECKSUM_PATH,
    PUBLIC_GOLD_SNAPSHOT_PATH,
  ].sort());
  assert.equal(calls.some((path) => path.startsWith("/api/")), false);
  assert.equal(graph.nodes.length, 68);
  assert.equal(graph.edges.length, 101);
  assert.equal(graph.meta.publicFixture, true);
});

test("공개 Gold checksum 변조와 orphan 관계를 차단한다", async () => {
  const snapshotText = await readFile(
    new URL("../public/atlas/atlas-gold-snapshot.json", import.meta.url),
    "utf8",
  );
  await assert.rejects(
    loadPublicGoldGraphSnapshot(async (path) => new Response(
      path === PUBLIC_GOLD_SNAPSHOT_PATH
        ? snapshotText
        : `${"0".repeat(64)}  atlas-gold-snapshot.json\n`,
      { status: 200 },
    )),
    /SHA-256/,
  );

  const gold = JSON.parse(snapshotText);
  gold.edges[0].target = "gold_public_00000000000000000000";
  assert.throws(() => validatePublicGoldGraphSnapshot(gold), /연결 대상/);
});
