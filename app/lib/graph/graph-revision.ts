export type GraphRevisionState = {
  documents: number;
  documentVersion: string;
  entities: number;
  mentions: number;
  relations: number;
  relationVersion: number;
  relationUpdatedAt: string;
};

export const GRAPH_REVISION_STORAGE_KEY = "ai-systems-atlas:graph-revision";

const safeInteger = (value: number) => Number.isSafeInteger(value) && value >= 0 ? value : 0;

/**
 * A compact, non-secret revision token for cache and client refresh decisions.
 * It intentionally contains only aggregate counters and storage versions.
 */
export function graphRevisionFromState(state: GraphRevisionState) {
  return [
    "atlas-graph-v1",
    safeInteger(state.documents),
    state.documentVersion || "none",
    safeInteger(state.entities),
    safeInteger(state.mentions),
    safeInteger(state.relations),
    safeInteger(state.relationVersion),
    state.relationUpdatedAt || "none",
  ].join(":");
}

export function shouldRefreshGraphRevision(current: string | null | undefined, next: string | null | undefined) {
  return Boolean(current && next && current !== next);
}
