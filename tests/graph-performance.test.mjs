import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function importTypeScript(relativePath) {
  const source = await readFile(new URL(relativePath, import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

const percentile = (values, ratio) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0;
};

test("orbit selection recenters the camera only when its center changes", async () => {
  const cameraFocus = await importTypeScript("../app/graph/camera-focus.ts");

  assert.equal(
    cameraFocus.shouldRecenterLayoutCamera({
      previousView: "constellation",
      nextView: "orbit",
      previousCenterId: null,
      nextCenterId: "node-a",
      animateTransition: true,
    }),
    true,
  );
  assert.equal(
    cameraFocus.shouldRecenterLayoutCamera({
      previousView: "orbit",
      nextView: "orbit",
      previousCenterId: "node-a",
      nextCenterId: "node-b",
      animateTransition: true,
    }),
    true,
  );
  assert.equal(
    cameraFocus.shouldRecenterLayoutCamera({
      previousView: "orbit",
      nextView: "orbit",
      previousCenterId: "node-b",
      nextCenterId: "node-b",
      animateTransition: true,
    }),
    false,
  );
  assert.equal(
    cameraFocus.shouldRecenterLayoutCamera({
      previousView: "nebula",
      nextView: "nebula",
      previousCenterId: null,
      nextCenterId: null,
      animateTransition: false,
    }),
    true,
  );
  assert.equal(cameraFocus.selectionCameraDistance(265, 35, 420), 265);
  assert.equal(cameraFocus.selectionCameraDistance(12, 35, 420), 35);
  assert.equal(cameraFocus.selectionCameraDistance(900, 35, 420), 420);
  assert.equal(cameraFocus.selectionCameraDistance(Number.NaN, 35, 420), 35);
});

test("camera fitting handles empty, single, wide, and tall visible ranges", async () => {
  const cameraFit = await importTypeScript("../app/graph/camera-fit.ts");

  assert.equal(cameraFit.calculateGraphBoundingSphere([]), null);
  assert.deepEqual(
    cameraFit.calculateGraphBoundingSphere([[5, -2, 9]]),
    { center: [5, -2, 9], radius: 0, count: 1 },
  );
  const sphere = cameraFit.calculateGraphBoundingSphere([
    [-10, -4, -2],
    [10, 4, 2],
    [0, 0, 0],
    [Number.NaN, 1, 2],
  ]);
  assert.deepEqual(sphere.center, [0, 0, 0]);
  assert.equal(sphere.count, 3);
  assert.ok(Math.abs(sphere.radius - Math.hypot(10, 4, 2)) < 1e-9);

  const landscape = cameraFit.perspectiveFitDistance({
    radius: 100,
    verticalFovDegrees: 50,
    aspect: 16 / 9,
    margin: 0.15,
    minDistance: 20,
    maxDistance: 2_000,
  });
  const portrait = cameraFit.perspectiveFitDistance({
    radius: 100,
    verticalFovDegrees: 50,
    aspect: 9 / 16,
    margin: 0.15,
    minDistance: 20,
    maxDistance: 2_000,
  });
  const ultraWide = cameraFit.perspectiveFitDistance({
    radius: 100,
    verticalFovDegrees: 50,
    aspect: 32 / 9,
    margin: 0.15,
    minDistance: 20,
    maxDistance: 2_000,
  });
  assert.ok(portrait > landscape);
  assert.ok(Math.abs(ultraWide - landscape) < 1e-9);
  assert.equal(
    cameraFit.perspectiveFitDistance({
      radius: 0,
      minimumRadius: 35,
      verticalFovDegrees: 50,
      aspect: 1,
      minDistance: 20,
      maxDistance: 200,
    }) > 20,
    true,
  );
  assert.equal(
    cameraFit.perspectiveFitDistance({
      radius: 10_000,
      verticalFovDegrees: 50,
      aspect: 1,
      minDistance: 20,
      maxDistance: 200,
    }),
    200,
  );

  const fullFrame = {
    width: 1_000,
    height: 800,
    left: 0,
    right: 1_000,
    top: 0,
    bottom: 800,
  };
  assert.equal(
    cameraFit.calculatePerspectiveBoundsFit({
      points: [],
      verticalFovDegrees: 50,
      aspect: 1.25,
      safeFrame: fullFrame,
      minDistance: 20,
      maxDistance: 2_000,
    }),
    null,
  );
  const singleFit = cameraFit.calculatePerspectiveBoundsFit({
    points: [[5, -2, 9]],
    verticalFovDegrees: 50,
    aspect: 1.25,
    safeFrame: fullFrame,
    minDistance: 35,
    maxDistance: 2_000,
  });
  assert.deepEqual(singleFit, {
    center: [5, -2, 9],
    targetOffset: [0, 0, 0],
    distance: 35,
    count: 1,
  });

  const alignedPoints = [
    [-80, -40, -16],
    [80, 40, 16],
    [-60, 30, 8],
    [42, -34, -10],
  ];
  const symmetricFit = cameraFit.calculatePerspectiveBoundsFit({
    points: alignedPoints,
    verticalFovDegrees: 50,
    aspect: 1.25,
    safeFrame: fullFrame,
    margin: 0.12,
    minDistance: 20,
    maxDistance: 2_000,
    nearDistance: 2,
  });
  const uiSafeFit = cameraFit.calculatePerspectiveBoundsFit({
    points: alignedPoints,
    verticalFovDegrees: 50,
    aspect: 1.25,
    safeFrame: {
      width: 1_000,
      height: 800,
      left: 310,
      right: 980,
      top: 74,
      bottom: 690,
    },
    margin: 0.12,
    minDistance: 20,
    maxDistance: 2_000,
    nearDistance: 2,
  });
  assert.ok(uiSafeFit.distance > symmetricFit.distance);
  assert.ok(uiSafeFit.targetOffset[0] < 0);
  assert.ok(uiSafeFit.targetOffset[1] < 0);

  const tanVertical = Math.tan(50 * Math.PI / 360);
  const tanHorizontal = tanVertical * 1.25;
  const innerBounds = {
    left: ((310 + (670 * 0.12 / 2)) / 1_000) * 2 - 1,
    right: ((980 - (670 * 0.12 / 2)) / 1_000) * 2 - 1,
    top: 1 - ((74 + (616 * 0.12 / 2)) / 800) * 2,
    bottom: 1 - ((690 - (616 * 0.12 / 2)) / 800) * 2,
  };
  alignedPoints.forEach(([x, y, z]) => {
    const depth = uiSafeFit.distance - (z - uiSafeFit.center[2]);
    const ndcX =
      (x - uiSafeFit.center[0] - uiSafeFit.targetOffset[0]) /
      (depth * tanHorizontal);
    const ndcY =
      (y - uiSafeFit.center[1] - uiSafeFit.targetOffset[1]) /
      (depth * tanVertical);
    assert.ok(ndcX >= innerBounds.left - 1e-9 && ndcX <= innerBounds.right + 1e-9);
    assert.ok(ndcY >= innerBounds.bottom - 1e-9 && ndcY <= innerBounds.top + 1e-9);
    assert.ok(depth >= 2);
  });

  const portraitBoundsFit = cameraFit.calculatePerspectiveBoundsFit({
    points: alignedPoints,
    verticalFovDegrees: 50,
    aspect: 9 / 16,
    safeFrame: { width: 450, height: 800, left: 12, right: 438, top: 70, bottom: 680 },
    minDistance: 20,
    maxDistance: 2_000,
  });
  const ultraWideBoundsFit = cameraFit.calculatePerspectiveBoundsFit({
    points: alignedPoints,
    verticalFovDegrees: 50,
    aspect: 32 / 9,
    safeFrame: { width: 1_600, height: 450, left: 320, right: 1_580, top: 70, bottom: 350 },
    minDistance: 20,
    maxDistance: 2_000,
  });
  assert.ok(portraitBoundsFit.distance > 0);
  assert.ok(ultraWideBoundsFit.distance > 0);
});

test("node sizing switches kind, p95 degree, and uniform modes within a safe range", async () => {
  const nodeSizing = await importTypeScript("../app/graph/node-sizing.ts");
  const kindSizes = {
    thesis: 18,
    concept: 10,
    system: 14,
    tool: 11,
    practice: 11,
    risk: 12,
  };
  const kinds = ["thesis", "concept", "system", "tool", "practice", "risk"];
  const degrees = new Float32Array([0, 1, 4, 8, 16, 10_000]);

  assert.deepEqual(
    [...nodeSizing.calculateNodeSizes("kind", kinds, degrees, kindSizes)],
    [18, 10, 14, 11, 11, 12],
  );
  assert.deepEqual(
    [...nodeSizing.calculateNodeSizes("uniform", kinds, degrees, kindSizes)],
    [11.5, 11.5, 11.5, 11.5, 11.5, 11.5],
  );
  const degreeSizes = nodeSizing.calculateNodeSizes(
    "degree",
    kinds,
    degrees,
    kindSizes,
  );
  assert.equal(degreeSizes[0], 8.5);
  assert.ok(degreeSizes[0] < degreeSizes[1]);
  assert.ok(degreeSizes[1] < degreeSizes[2]);
  assert.ok(degreeSizes[2] < degreeSizes[3]);
  assert.ok(degreeSizes[3] < degreeSizes[4]);
  assert.equal(degreeSizes[5], 18);
  assert.deepEqual(nodeSizing.nodeSizeRange(degreeSizes), {
    minimum: 8.5,
    maximum: 18,
  });

  const zeroSizes = nodeSizing.calculateNodeSizes(
    "degree",
    Array(500).fill("concept"),
    new Float32Array(500),
    kindSizes,
  );
  assert.deepEqual(nodeSizing.nodeSizeRange(zeroSizes), {
    minimum: 8.5,
    maximum: 8.5,
  });
  const equalSizes = nodeSizing.calculateNodeSizes(
    "degree",
    Array(12).fill("concept"),
    new Float32Array(12).fill(7),
    kindSizes,
  );
  assert.deepEqual(nodeSizing.nodeSizeRange(equalSizes), {
    minimum: 18,
    maximum: 18,
  });
  const extremeDegrees = new Float32Array(500).fill(2);
  extremeDegrees[499] = 1_000_000;
  const extremeSizes = nodeSizing.calculateNodeSizes(
    "degree",
    Array(500).fill("concept"),
    extremeDegrees,
    kindSizes,
  );
  assert.equal(extremeSizes[0], 18);
  assert.equal(extremeSizes[499], 18);
  assert.ok([...extremeSizes].every((size) => size >= 8.5 && size <= 18));
  assert.equal(nodeSizing.percentile95([0, 1, 2, 3, 1_000]), 1_000);
});

test("render positions always synchronize before optional node motion", async () => {
  const positionSync = await importTypeScript("../app/graph/position-sync.ts");
  const base = new Float32Array([1, 2, 3, 10, 20, 30]);
  const rendered = new Float32Array([99, 99, 99, -1, -1, -1]);

  positionSync.syncRenderedNodePositions(base, rendered);
  assert.deepEqual([...rendered], [...base]);
  assert.deepEqual(positionSync.renderedNodePosition(rendered, 1), [10, 20, 30]);
  assert.equal(positionSync.renderedNodePosition(rendered, -1), null);
  assert.equal(positionSync.renderedNodePosition(rendered, 2), null);
  assert.throws(
    () => positionSync.syncRenderedNodePositions(base, new Float32Array(3)),
    /equal lengths/,
  );
});

test("500-node and 2,000-edge fixture is deterministic and layouts stay within CPU budget", async (t) => {
  const [{ createPerformanceGraphSnapshot }, layouts] = await Promise.all([
    importTypeScript("../app/lib/graph/performance-fixture.ts"),
    importTypeScript("../app/graph/layouts.ts"),
  ]);
  const graph = createPerformanceGraphSnapshot(500, 2_000);
  assert.equal(graph.nodes.length, 500);
  assert.equal(graph.edges.length, 2_000);
  assert.equal(new Set(graph.nodes.map((node) => node.id)).size, 500);
  assert.equal(
    new Set(graph.edges.map((edge) => `${edge.source}|${edge.target}|${edge.type}`)).size,
    2_000,
  );

  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  assert.ok(graph.edges.every((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)));
  const basePositions = graph.nodes.map((_, index) => [index % 25, Math.floor(index / 25), index % 7]);

  layouts.nebulaLayout(graph.nodes, 500);
  layouts.orbitLayout(graph.nodes, graph.edges, 500, graph.nodes[0].id);

  const nebulaDurations = [];
  const orbitDurations = [];
  for (let index = 0; index < 30; index += 1) {
    let startedAt = performance.now();
    const nebula = layouts.calculateLayout(
      "nebula",
      graph.nodes,
      graph.edges,
      basePositions,
      500,
    );
    nebulaDurations.push(performance.now() - startedAt);
    assert.equal(nebula.positions.length, 500);

    startedAt = performance.now();
    const orbit = layouts.calculateLayout(
      "orbit",
      graph.nodes,
      graph.edges,
      basePositions,
      500,
      graph.nodes[index % graph.nodes.length].id,
    );
    orbitDurations.push(performance.now() - startedAt);
    assert.equal(orbit.positions.length, 500);
  }

  const nebulaP95 = percentile(nebulaDurations, 0.95);
  const orbitP95 = percentile(orbitDurations, 0.95);
  t.diagnostic(`layout benchmark p95: nebula=${nebulaP95.toFixed(2)}ms orbit=${orbitP95.toFixed(2)}ms`);
  assert.ok(nebulaP95 < 50, `nebula p95 ${nebulaP95.toFixed(2)}ms exceeded 50ms`);
  assert.ok(orbitP95 < 80, `orbit p95 ${orbitP95.toFixed(2)}ms exceeded 80ms`);
});

test("Markdown validation enforces the 2MB boundary without allocating a multipart payload", async () => {
  const { MAX_MARKDOWN_FILE_SIZE, decodeMarkdownBytes, validateDecodedMarkdown } = await importTypeScript(
    "../app/lib/markdown/validate-markdown.ts",
  );
  assert.throws(
    () => validateDecodedMarkdown("oversized.md", "# oversized", MAX_MARKDOWN_FILE_SIZE + 1),
    /2MB/,
  );
  assert.doesNotThrow(() =>
    validateDecodedMarkdown("within-limit.md", "# valid", MAX_MARKDOWN_FILE_SIZE),
  );
  assert.equal(
    decodeMarkdownBytes("literal-replacement.md", new TextEncoder().encode("# valid � fixture").buffer),
    "# valid � fixture",
  );
  assert.throws(
    () => decodeMarkdownBytes("invalid-utf8.md", Uint8Array.from([0x23, 0x20, 0xc3, 0x28]).buffer),
    /UTF-8/,
  );
});

test("selection focus separates direct, expanded, and unrelated graph tiers", async () => {
  const focus = await importTypeScript("../app/graph/focus.ts");
  const edges = [
    { source: "a", target: "b", type: "supports" },
    { source: "b", target: "c", type: "uses" },
    { source: "b", target: "d", type: "extends" },
    { source: "c", target: "e", type: "requires" },
  ];
  const result = focus.buildSelectionFocus(edges, "a");

  assert.deepEqual([...result.directNodeIds], ["b"]);
  assert.deepEqual([...result.expandedNodeIds].sort(), ["c", "d"]);
  assert.deepEqual([...result.directEdgeIds], ["a|b|supports"]);
  assert.deepEqual(
    [...result.expandedEdgeIds].sort(),
    ["b|c|uses", "b|d|extends"],
  );
  assert.deepEqual([...result.nodeIds].sort(), ["a", "b", "c", "d"]);
  assert.equal(result.nodeIds.has("e"), false);
  assert.equal(focus.EXPANDED_FOCUS_VISIBILITY, 0.62);

  const all = focus.selectionVisibilityForDepth(result, "a", "all");
  assert.equal(all.nodeIds, null);
  assert.equal(all.edgeIds, null);

  const direct = focus.selectionVisibilityForDepth(result, "a", "direct");
  assert.deepEqual([...direct.nodeIds].sort(), ["a", "b"]);
  assert.deepEqual([...direct.edgeIds], ["a|b|supports"]);

  const expanded = focus.selectionVisibilityForDepth(result, "a", "expanded");
  assert.deepEqual([...expanded.nodeIds].sort(), ["a", "b", "c", "d"]);
  assert.deepEqual(
    [...expanded.edgeIds].sort(),
    ["a|b|supports", "b|c|uses", "b|d|extends"],
  );

  const filtered = {
    nodeIds: new Set(["b", "c", "e"]),
    edgeIds: new Set(["b|c|uses", "c|e|requires"]),
  };
  const intersection = focus.intersectFocusVisibility(
    expanded,
    filtered,
    "a",
  );
  assert.deepEqual([...intersection.nodeIds].sort(), ["a", "b", "c"]);
  assert.deepEqual([...intersection.edgeIds], ["b|c|uses"]);

  const isolated = focus.buildSelectionFocus([], "isolated");
  const isolatedVisibility = focus.selectionVisibilityForDepth(
    isolated,
    "isolated",
    "expanded",
  );
  assert.deepEqual([...isolatedVisibility.nodeIds], ["isolated"]);
  assert.deepEqual([...isolatedVisibility.edgeIds], []);

  const boundary = focus.buildSelectionFocus([
    { source: "a", target: "a", type: "supports" },
    { source: "a", target: "b", type: "supports" },
    { source: "a", target: "b", type: "supports" },
    { source: "b", target: "a", type: "requires" },
  ], "a");
  assert.deepEqual([...boundary.directNodeIds], ["b"]);
  assert.deepEqual(
    [...boundary.directEdgeIds].sort(),
    ["a|a|supports", "a|b|supports", "b|a|requires"],
  );

  assert.deepEqual(
    focus.visibleGraphCounts(
      ["a", "b", "c"],
      edges,
      { nodeIds: new Set(["a", "b"]), edgeIds: new Set(["a|b|supports"]) },
    ),
    { nodes: 2, edges: 1 },
  );
});

test("relation visibility presets share the sidebar layer state without changing data", async () => {
  const relationVisibility = await importTypeScript(
    "../app/graph/relation-visibility.ts",
  );

  assert.deepEqual(
    relationVisibility.relationLayersForVisibilityPreset("all"),
    [],
  );
  assert.deepEqual(
    relationVisibility.relationLayersForVisibilityPreset("evidence"),
    ["structural", "explicit", "inferred"],
  );
  assert.deepEqual(
    relationVisibility.relationLayersForVisibilityPreset("display"),
    ["display"],
  );
  assert.equal(
    relationVisibility.relationVisibilityPresetForLayers(new Set()),
    "all",
  );
  assert.equal(
    relationVisibility.relationVisibilityPresetForLayers(
      new Set(["structural", "explicit", "inferred", "display"]),
    ),
    "all",
  );
  assert.equal(
    relationVisibility.relationVisibilityPresetForLayers(
      new Set(["structural", "explicit", "inferred"]),
    ),
    "evidence",
  );
  assert.equal(
    relationVisibility.relationVisibilityPresetForLayers(new Set(["display"])),
    "display",
  );
  assert.equal(
    relationVisibility.relationVisibilityPresetForLayers(
      new Set(["explicit", "display"]),
    ),
    "custom",
  );
  assert.equal(
    relationVisibility.relationLayerForEdge({
      source: "a",
      target: "b",
      type: "supports",
      layer: "explicit",
    }),
    "explicit",
  );
  assert.equal(
    relationVisibility.relationLayerForEdge({
      source: "a",
      target: "b",
      type: "related_to",
      origin: "display",
    }),
    "display",
  );
  assert.equal(
    relationVisibility.relationLayerForEdge({
      source: "a",
      target: "b",
      type: "contains",
    }),
    "structural",
  );
});

test("label LOD increases with zoom and prioritizes selected relationship distance", async () => {
  const labelLod = await importTypeScript("../app/graph/label-lod.ts");

  assert.equal(labelLod.resolveLabelLod(200, 100), "overview");
  assert.equal(labelLod.resolveLabelLod(120, 100), "explore");
  assert.equal(labelLod.resolveLabelLod(80, 100), "detail");
  assert.ok(
    labelLod.labelLimit("overview", false, false) <
      labelLod.labelLimit("explore", false, false),
  );
  assert.ok(
    labelLod.labelLimit("explore", false, false) <
      labelLod.labelLimit("detail", false, false),
  );
  assert.ok(
    labelLod.labelLimit("overview", false, false, "low") <
      labelLod.labelLimit("overview", false, false, "medium"),
  );
  assert.ok(
    labelLod.labelLimit("overview", false, false, "medium") <
      labelLod.labelLimit("overview", false, false, "high"),
  );

  const candidates = [
    { id: "selected", kind: "concept", degree: 1, focusTier: "selected" },
    { id: "direct", kind: "tool", degree: 1, focusTier: "direct" },
    { id: "expanded", kind: "practice", degree: 1, focusTier: "expanded" },
    { id: "thesis", kind: "thesis", degree: 10, focusTier: "ambient" },
    ...Array.from({ length: 10 }, (_, index) => ({
      id: `ambient-${index}`,
      kind: "system",
      degree: 20 - index,
      focusTier: "ambient",
    })),
  ];
  const selectedIds = labelLod.selectLabelIds(
    candidates,
    "overview",
    false,
    true,
  );

  assert.equal(selectedIds.size, 8);
  assert.equal(selectedIds.has("selected"), true);
  assert.equal(selectedIds.has("direct"), true);
  assert.equal(selectedIds.has("expanded"), true);
  assert.ok(
    labelLod.selectLabelIds(candidates, "overview", false, true, "high").size >
      labelLod.selectLabelIds(candidates, "overview", false, true, "low").size,
  );
  assert.ok(
    labelLod.scoreLabelCandidate(candidates[0]) >
      labelLod.scoreLabelCandidate(candidates[1]),
  );
  assert.ok(
    labelLod.scoreLabelCandidate(candidates[1]) >
      labelLod.scoreLabelCandidate(candidates[2]),
  );
  assert.ok(
    labelLod.scoreLabelCandidate(candidates[2]) >
      labelLod.scoreLabelCandidate(candidates[3]),
  );
});

test("label collision resolution keeps higher-priority labels and rejects viewport overflow", async () => {
  const collision = await importTypeScript("../app/graph/label-collision.ts");
  const visibleIds = collision.resolveLabelCollisions(
    [
      { id: "ambient", x: 24, y: 24, width: 120, height: 20, priority: 100 },
      { id: "selected", x: 30, y: 28, width: 110, height: 20, priority: 4_000 },
      {
        id: "stable",
        x: 180,
        y: 24,
        width: 100,
        height: 20,
        priority: 500,
        previouslyVisible: true,
      },
      { id: "clipped", x: 345, y: 40, width: 80, height: 20, priority: 8_000 },
      { id: "outside", x: 401, y: 40, width: 90, height: 20, priority: 9_000 },
    ],
    { width: 400, height: 220, inset: 6 },
    5,
  );

  assert.deepEqual([...visibleIds].sort(), ["selected", "stable"]);
  assert.equal(visibleIds.has("ambient"), false);
  assert.equal(visibleIds.has("clipped"), false);
  assert.equal(visibleIds.has("outside"), false);
});

test("orbit depth descriptors map the selected center to direct and expanded rings", async () => {
  const orbitDepth = await importTypeScript("../app/graph/orbit-depth.ts");
  const descriptors = orbitDepth.orbitDepthDescriptors(
    "검색 증강 생성",
    7,
    14,
  );

  assert.deepEqual(
    descriptors.map(({ key, title, detail, count }) => ({ key, title, detail, count })),
    [
      { key: "core", title: "CORE", detail: "검색 증강 생성", count: 1 },
      { key: "depth-1", title: "DEPTH 01", detail: "DIRECT", count: 7 },
      { key: "depth-2", title: "DEPTH 02", detail: "EXTENDED", count: 14 },
    ],
  );
  assert.deepEqual(orbitDepth.orbitDepthAnchor("core", [72, 128]), [0, 0, 0]);
  assert.notDeepEqual(
    orbitDepth.orbitDepthAnchor("depth-1", [72, 128]),
    orbitDepth.orbitDepthAnchor("depth-2", [72, 128]),
  );
});

test("luminosity v2 keeps the reduced preset hierarchy on compact screens and clamps unsafe inputs", async () => {
  const luminosity = await importTypeScript("../app/graph/luminosity.ts");
  const normal = luminosity.resolveLuminositySettings("normal", {
    compact: false,
    previewV2: true,
  });
  const bright = luminosity.resolveLuminositySettings("bright", {
    compact: false,
    previewV2: true,
  });
  const supernova = luminosity.resolveLuminositySettings("supernova", {
    compact: false,
    previewV2: true,
  });
  const compactSupernova = luminosity.resolveLuminositySettings("supernova", {
    compact: true,
    previewV2: true,
  });
  const classicCompactSupernova = luminosity.resolveLuminositySettings("supernova", {
    compact: true,
    previewV2: false,
  });

  for (const key of [
    "light",
    "bloom",
    "edgeIntensity",
    "particleIntensity",
    "ambientNodeBoost",
    "ambientEdgeBrightness",
  ]) {
    assert.ok(normal[key] < bright[key], `${key} should increase from normal to bright`);
    assert.ok(bright[key] < supernova[key], `${key} should increase from bright to supernova`);
  }
  assert.deepEqual(compactSupernova, supernova);
  assert.equal(classicCompactSupernova.light, 1.28);
  assert.deepEqual(luminosity.luminosityPresetControls, {
    normal: {
      overall: 55,
      edges: 20,
      bloom: 12,
      particles: 15,
      focusContrast: "medium",
    },
    bright: {
      overall: 70,
      edges: 32,
      bloom: 28,
      particles: 30,
      focusContrast: "medium",
    },
    supernova: {
      overall: 90,
      edges: 50,
      bloom: 45,
      particles: 50,
      focusContrast: "medium",
    },
  });

  const clamped = luminosity.normalizeLuminositySettings({
    light: Number.NaN,
    bloom: 99,
    dust: -1,
    photon: Number.POSITIVE_INFINITY,
    edgeIntensity: 99,
    particleIntensity: -1,
    ambientNodeBoost: 5,
    ambientEdgeBrightness: -3,
    outputCeiling: 99,
  });
  assert.equal(clamped.light, 0.5);
  assert.equal(clamped.bloom, 1.45);
  assert.equal(clamped.dust, 0);
  assert.equal(clamped.photon, 0);
  assert.equal(clamped.edgeIntensity, 1);
  assert.equal(clamped.particleIntensity, 0);
  assert.equal(clamped.ambientNodeBoost, 1.32);
  assert.equal(clamped.ambientEdgeBrightness, 0);
  assert.equal(clamped.outputCeiling, 2.5);

  const customControls = luminosity.normalizeLuminosityControls({
    overall: 999,
    edges: -1,
    bloom: Number.NaN,
    particles: Number.POSITIVE_INFINITY,
    focusContrast: "invalid",
  });
  assert.deepEqual(customControls, {
    overall: 150,
    edges: 0,
    bloom: 0,
    particles: 0,
    focusContrast: "medium",
  });
  assert.deepEqual(
    luminosity.resolveLuminosityControls(luminosity.luminosityPresetControls.supernova),
    supernova,
  );
  assert.deepEqual(luminosity.defaultCustomLuminosityControls, {
    overall: 150,
    edges: 20,
    bloom: 20,
    particles: 100,
    focusContrast: "medium",
  });
  const minimumEdges = luminosity.resolveLuminosityControls({
    ...luminosity.luminosityPresetControls.bright,
    edges: 0,
  });
  const maximumEdges = luminosity.resolveLuminosityControls({
    ...luminosity.luminosityPresetControls.bright,
    edges: 100,
  });
  assert.ok(minimumEdges.edgeIntensity < maximumEdges.edgeIntensity);
  assert.ok(minimumEdges.ambientEdgeBrightness < maximumEdges.ambientEdgeBrightness);
  assert.equal(minimumEdges.edgeIntensity, 0);
  assert.equal(minimumEdges.ambientEdgeBrightness, 0);

  const noBloom = luminosity.resolveLuminosityControls({
    ...luminosity.defaultCustomLuminosityControls,
    bloom: 0,
  });
  assert.equal(noBloom.bloom, 0);

  const noParticles = luminosity.resolveLuminosityControls({
    ...luminosity.luminosityPresetControls.bright,
    particles: 0,
  });
  assert.equal(noParticles.dust, 0);
  assert.equal(noParticles.photon, 0);
  assert.equal(noParticles.particleIntensity, 0);
  assert.equal(supernova.particleIntensity, 0.5);
  assert.ok(
    luminosity.resolveFocusContrast("low").dimmedNodeBoost >
      luminosity.resolveFocusContrast("high").dimmedNodeBoost,
  );
  assert.equal(luminosity.resolveFocusContrast("low").dimmedEdgeBrightness, 0.25);
  assert.equal(luminosity.resolveFocusContrast("medium").dimmedEdgeBrightness, 0.2);
  assert.equal(luminosity.resolveFocusContrast("high").dimmedEdgeBrightness, 0.15);
});

test("compact graph controls keep grouped horizontal access without dropping controls", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const responsiveStart = css.indexOf("@media (max-width: 960px)");
  const compactStart = css.indexOf("@media (max-width: 760px)");
  const phoneStart = css.indexOf("@media (max-width: 640px)");

  assert.ok(responsiveStart >= 0);
  assert.ok(compactStart > responsiveStart);
  assert.ok(phoneStart > compactStart);

  const baseRules = css.slice(0, responsiveStart);
  assert.match(
    baseRules,
    /grid-template-areas:\s*"status view data explore"\s*"status stage stage stage"/,
  );
  assert.match(baseRules, /\.explore-cluster\s*\{[\s\S]*?grid-area:\s*explore/);
  assert.match(baseRules, /\.stage-cluster\s*\{[\s\S]*?grid-area:\s*stage/);

  const responsiveRules = css.slice(responsiveStart, compactStart);
  const compactRules = css.slice(compactStart, phoneStart);
  assert.match(responsiveRules, /overflow-x:\s*auto/);
  assert.match(responsiveRules, /overscroll-behavior-x:\s*contain/);
  assert.match(responsiveRules, /scroll-snap-type:\s*x proximity/);
  assert.match(responsiveRules, /\.control-cluster\s*\{[\s\S]*?flex:\s*0 0 auto/);
  assert.match(compactRules, /min-width:\s*36px/);
  assert.match(compactRules, /\.graph-controls button em,[\s\S]*?display:\s*none/);
});

test("phone controls use a clipped-safe two-row grid without horizontal scrolling", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const phoneStart = css.indexOf("@media (max-width: 640px)");
  const narrowPhoneStart = css.indexOf("@media (max-width: 360px)");
  const phoneRules = css.slice(phoneStart, narrowPhoneStart);

  assert.ok(phoneStart >= 0);
  assert.ok(narrowPhoneStart > phoneStart);
  assert.match(phoneRules, /\.graph-controls\s*\{\s*display:\s*none/);
  assert.match(phoneRules, /\.mobile-graph-controls\s*\{[\s\S]*?right:\s*8px[\s\S]*?left:\s*8px/);
  assert.match(phoneRules, /\.mobile-graph-controls\s*\{[\s\S]*?overflow:\s*hidden/);
  assert.match(phoneRules, /bottom:\s*calc\(34px \+ env\(safe-area-inset-bottom, 0px\)\)/);
  assert.match(phoneRules, /\.mobile-primary-controls\s*\{\s*grid-template-columns:\s*repeat\(5, minmax\(0, 1fr\)\)/);
  assert.match(phoneRules, /\.mobile-stage-controls\s*\{[\s\S]*?grid-template-columns:\s*repeat\(7, minmax\(0, 1fr\)\)/);
  assert.match(phoneRules, /\.mobile-graph-controls button\s*\{[\s\S]*?min-width:\s*0[\s\S]*?height:\s*40px/);
  assert.doesNotMatch(phoneRules, /\.mobile-graph-controls\s*\{[\s\S]*?overflow-x:\s*auto/);
});

test("the public deployment data option uses a self-contained SVG icon", async () => {
  const source = await readFile(
    new URL("../app/knowledge-graph.tsx", import.meta.url),
    "utf8",
  );
  const iconStart = source.indexOf('<svg\n                  className="data-option-public"');
  const iconEnd = source.indexOf("</svg>", iconStart);

  assert.ok(iconStart >= 0 && iconEnd > iconStart);
  const iconSource = source.slice(iconStart, iconEnd);
  assert.match(iconSource, /width="18"/);
  assert.match(iconSource, /height="18"/);
  assert.match(iconSource, /stroke="#79d5c0"/);
  assert.match(iconSource, /fill="#79d5c0"/);
});

test("dust, nebula, and photons share one circular soft-glow texture", async () => {
  const source = await readFile(
    new URL("../app/knowledge-graph.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /const particleGlowTexture = createParticleGlowTexture\(\)/);
  assert.equal(source.match(/map: particleGlowTexture/g)?.length, 3);
  assert.equal(source.match(/alphaTest: 0\.012/g)?.length, 3);
  assert.match(source, /gradient\.addColorStop\(1, "rgba\(255, 255, 255, 0\)"\)/);
  assert.match(source, /particleGlowTexture\.dispose\(\)/);
});

test("initial graph loading is Strict Mode safe and the relation shader enables vertex colors", async () => {
  const source = await readFile(
    new URL("../app/knowledge-graph.tsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /dataSourceInitializedRef/);
  assert.match(source, />\s*다시 시도\s*</);
  const materialStart = source.indexOf("const edgeMaterial = new THREE.ShaderMaterial");
  const materialEnd = source.indexOf("const edgeLines =", materialStart);
  assert.ok(materialStart > 0 && materialEnd > materialStart);
  const materialSource = source.slice(materialStart, materialEnd);
  assert.match(materialSource, /vertexColors:\s*true/);
  assert.match(materialSource, /vColor = color/);
  assert.equal(source.match(/setAttribute\("size"/g)?.length, 1);
  assert.match(source, /nodeGeometry\.attributes\.size\.needsUpdate = true/);
});
