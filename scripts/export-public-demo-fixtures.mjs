import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Text, stableJson } from "./lib/public-graph-artifact.mjs";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixturePath = resolve(projectRoot, "tests/fixtures/knowledge-graph/gold-memory-node-graph.json");
const outputDirectory = resolve(projectRoot, "public/atlas");
const snapshotPath = resolve(outputDirectory, "atlas-gold-snapshot.json");
const checksumPath = resolve(outputDirectory, "atlas-gold-snapshot.sha256");
const checkOnly = process.argv.includes("--check");

const raw = JSON.parse(await readFile(fixturePath, "utf8"));
const nodeId = (value) => `gold_public_${sha256Text(`atlas-public-gold-v1\0${value}`).slice(0, 20)}`;
const ids = new Map(raw.nodes.map((node) => [node.id, nodeId(node.id)]));
const nodes = raw.nodes.map((node) => ({
  id: ids.get(node.id),
  label: String(node.label).slice(0, 320),
  shortLabel: String(node.label).slice(0, 180),
  kind: node.display.kind,
  domain: node.display.domain,
  summary: String(node.summary).slice(0, 1_200),
  insight: `${String(node.type).toUpperCase()} · 공개 검토 표본 · ${node.status}`.slice(0, 1_600),
  tags: [...new Set([`ontology:${node.type}`, node.type, node.status])].sort(),
}));
const edges = raw.edges.map((edge) => ({
  source: ids.get(edge.source),
  target: ids.get(edge.target),
  type: edge.displayType,
  confidence: Math.max(0, Math.min(1, Number(edge.confidence))),
  note: `${edge.relation} · ${edge.note}`.slice(0, 600),
  layer: edge.layer,
  origin: edge.layer === "inferred" ? "codex" : edge.layer === "display" ? "display" : "rule",
}));
const factualEdges = edges.filter((edge) => edge.layer !== "display").length;
const snapshot = {
  schemaVersion: "atlas-public-fixture-graph/v1",
  nodes,
  edges,
  meta: {
    source: "demo",
    provider: "gold-graph-fixture",
    generatedAt: raw.generatedAt,
    documentCount: raw.selection.documentCount,
    totalNodeCount: nodes.length,
    totalEdgeCount: edges.length,
    projectedFactualEdgeCount: factualEdges,
    displayEdgeCount: edges.length - factualEdges,
    publicFixture: true,
    message: `ONTOLOGY V1 PUBLIC GOLD SAMPLE · ${raw.selection.documentCount} documents · ${nodes.length} nodes · ${edges.length} relations · NOT FULL CORPUS`,
  },
};
const snapshotText = stableJson(snapshot);
const checksum = sha256Text(snapshotText);
const checksumText = `${checksum}  atlas-gold-snapshot.json\n`;

if (checkOnly) {
  const [currentSnapshot, currentChecksum] = await Promise.all([
    readFile(snapshotPath, "utf8").catch(() => null),
    readFile(checksumPath, "utf8").catch(() => null),
  ]);
  if (currentSnapshot !== snapshotText || currentChecksum !== checksumText) {
    throw new Error(
      "공개 Gold Graph artifact가 원본 fixture와 다릅니다. 로컬에서 `npm run graph:export-public-fixtures`를 실행하고 diff를 검토하세요.",
    );
  }
  console.log(JSON.stringify({
    mode: "verified",
    snapshotPath,
    nodes: nodes.length,
    edges: edges.length,
    snapshotSha256: checksum,
  }, null, 2));
  process.exit(0);
}

const writeIfChanged = async (path, content) => {
  const current = await readFile(path, "utf8").catch(() => null);
  if (current === content) return false;
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, path);
  return true;
};

const changed = (await Promise.all([
  writeIfChanged(snapshotPath, snapshotText),
  writeIfChanged(checksumPath, checksumText),
])).some(Boolean);

console.log(JSON.stringify({
  mode: changed ? "written" : "unchanged",
  snapshotPath,
  nodes: nodes.length,
  edges: edges.length,
  snapshotSha256: checksum,
}, null, 2));
