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

test("luminosity v2 keeps supernova maximal on compact screens and clamps unsafe inputs", async () => {
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
  assert.equal(clamped.ambientEdgeBrightness, 0.2);
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
    edges: 20,
    bloom: 0,
    particles: 0,
    focusContrast: "medium",
  });
  assert.deepEqual(
    luminosity.resolveLuminosityControls(luminosity.luminosityPresetControls.supernova),
    supernova,
  );
  const minimumEdges = luminosity.resolveLuminosityControls({
    ...luminosity.luminosityPresetControls.bright,
    edges: 20,
  });
  const maximumEdges = luminosity.resolveLuminosityControls({
    ...luminosity.luminosityPresetControls.bright,
    edges: 100,
  });
  assert.ok(minimumEdges.edgeIntensity < maximumEdges.edgeIntensity);
  assert.ok(minimumEdges.ambientEdgeBrightness < maximumEdges.ambientEdgeBrightness);

  const noParticles = luminosity.resolveLuminosityControls({
    ...luminosity.luminosityPresetControls.bright,
    particles: 0,
  });
  assert.equal(noParticles.dust, 0);
  assert.equal(noParticles.photon, 0);
  assert.equal(noParticles.particleIntensity, 0);
  assert.equal(supernova.particleIntensity, 1);
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

  const responsiveRules = css.slice(responsiveStart, compactStart);
  const compactRules = css.slice(compactStart, phoneStart);
  assert.match(responsiveRules, /overflow-x:\s*auto/);
  assert.match(responsiveRules, /overscroll-behavior-x:\s*contain/);
  assert.match(responsiveRules, /scroll-snap-type:\s*x proximity/);
  assert.match(responsiveRules, /\.control-cluster\s*\{[\s\S]*?flex:\s*0 0 auto/);
  assert.match(compactRules, /min-width:\s*36px/);
  assert.match(compactRules, /\.graph-controls button em,[\s\S]*?display:\s*none/);
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
});
