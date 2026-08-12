import type { KnowledgeEdge, RelationLayer } from "../graph-data";

export type RelationVisibilityPreset = "all" | "evidence" | "display" | "custom";

export const ALL_RELATION_LAYERS: readonly RelationLayer[] = [
  "structural",
  "explicit",
  "inferred",
  "display",
];

export const EVIDENCE_RELATION_LAYERS: readonly RelationLayer[] = [
  "structural",
  "explicit",
  "inferred",
];

export const DISPLAY_RELATION_LAYERS: readonly RelationLayer[] = ["display"];

const hasExactly = (
  layers: ReadonlySet<RelationLayer>,
  expected: readonly RelationLayer[],
) => layers.size === expected.length && expected.every((layer) => layers.has(layer));

export function relationVisibilityPresetForLayers(
  layers: ReadonlySet<RelationLayer>,
): RelationVisibilityPreset {
  if (layers.size === 0 || hasExactly(layers, ALL_RELATION_LAYERS)) return "all";
  if (hasExactly(layers, EVIDENCE_RELATION_LAYERS)) return "evidence";
  if (hasExactly(layers, DISPLAY_RELATION_LAYERS)) return "display";
  return "custom";
}

export function relationLayersForVisibilityPreset(
  preset: Exclude<RelationVisibilityPreset, "custom">,
): readonly RelationLayer[] {
  if (preset === "evidence") return EVIDENCE_RELATION_LAYERS;
  if (preset === "display") return DISPLAY_RELATION_LAYERS;
  // An empty set is the existing single-source-of-truth representation for
  // "no layer filter", which is semantically equivalent to all four layers.
  return [];
}

export const relationLayerForEdge = (edge: KnowledgeEdge): RelationLayer =>
  edge.layer
  ?? (edge.origin === "codex"
    ? "inferred"
    : edge.origin === "display"
      ? "display"
      : ["documents", "plans", "contains"].includes(edge.type)
        ? "structural"
        : "explicit");
