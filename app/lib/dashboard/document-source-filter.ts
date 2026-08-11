import type { DocumentRecord } from "../graph/model.js";

export const DASHBOARD_DOCUMENT_SOURCE_FILTERS = ["all", "manual", "github"] as const;
export const DASHBOARD_DOCUMENT_PAGE_SIZE = 20;
export type DashboardDocumentSourceFilter = (typeof DASHBOARD_DOCUMENT_SOURCE_FILTERS)[number];

export type DashboardDocumentSourceCounts = Record<DashboardDocumentSourceFilter, number>;

export function countDashboardDocumentsBySource(
  documents: readonly DocumentRecord[],
): DashboardDocumentSourceCounts {
  return documents.reduce<DashboardDocumentSourceCounts>((counts, document) => {
    counts.all += 1;
    counts[document.sourceType] += 1;
    return counts;
  }, { all: 0, manual: 0, github: 0 });
}

export function filterDashboardDocumentsBySource(
  documents: readonly DocumentRecord[],
  filter: DashboardDocumentSourceFilter,
): DocumentRecord[] {
  return filter === "all"
    ? [...documents]
    : documents.filter((document) => document.sourceType === filter);
}

export function sliceDashboardDocuments(
  documents: readonly DocumentRecord[],
  visibleLimit: number,
): DocumentRecord[] {
  const safeLimit = Number.isFinite(visibleLimit)
    ? Math.max(0, Math.trunc(visibleLimit))
    : DASHBOARD_DOCUMENT_PAGE_SIZE;
  return documents.slice(0, safeLimit);
}
