export type GraphNavigationScope = "corpus" | "overview" | "repository";

export type GraphPresentationReturnState = {
  viewMode: "constellation" | "nebula" | "orbit";
  selectedNodeId: string | null;
};

export type GraphScopeHistoryState = {
  selectedNodeId: string | null;
  activeLens: string;
  activeDomains: string[];
  activeKinds: string[];
  activeRelations: string[];
};

export type GraphApiRequest = {
  path: string;
  implicitScope: boolean;
};

const graphScopeHistoryKey = "aiSystemsAtlasGraphScope";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const uniqueStrings = (values: readonly string[]) => [...new Set(values)];

export function graphScopeHistoryStateFromHistoryState(
  historyState: unknown,
): GraphScopeHistoryState | null {
  if (!isRecord(historyState) || !isRecord(historyState[graphScopeHistoryKey])) return null;
  const candidate = historyState[graphScopeHistoryKey];
  if (
    typeof candidate.activeLens !== "string"
    || !isStringList(candidate.activeDomains)
    || !isStringList(candidate.activeKinds)
    || !isStringList(candidate.activeRelations)
    || (candidate.selectedNodeId !== null && typeof candidate.selectedNodeId !== "string")
  ) return null;
  return {
    selectedNodeId: candidate.selectedNodeId,
    activeLens: candidate.activeLens,
    activeDomains: uniqueStrings(candidate.activeDomains),
    activeKinds: uniqueStrings(candidate.activeKinds),
    activeRelations: uniqueStrings(candidate.activeRelations),
  };
}

export function historyStateWithGraphScopeState(
  historyState: unknown,
  scopeState: GraphScopeHistoryState,
) {
  const base = isRecord(historyState) ? historyState : {};
  return {
    ...base,
    [graphScopeHistoryKey]: {
      selectedNodeId: scopeState.selectedNodeId,
      activeLens: scopeState.activeLens,
      activeDomains: uniqueStrings(scopeState.activeDomains),
      activeKinds: uniqueStrings(scopeState.activeKinds),
      activeRelations: uniqueStrings(scopeState.activeRelations),
    },
  };
}

export function graphApiRequestFromPageUrl(pageUrl: URL): GraphApiRequest {
  const apiUrl = new URL("/api/graph", pageUrl.origin);
  const showcase = pageUrl.searchParams.get("showcase");
  const fixture = pageUrl.searchParams.get("fixture");
  if (showcase) apiUrl.searchParams.set("showcase", showcase);
  if (fixture) apiUrl.searchParams.set("fixture", fixture);
  if (showcase || fixture) {
    return { path: `${apiUrl.pathname}${apiUrl.search}`, implicitScope: false };
  }

  const requestedScope = pageUrl.searchParams.get("scope");
  const implicitScope = requestedScope === null;
  apiUrl.searchParams.set("scope", requestedScope ?? "corpus");
  if (requestedScope === "repository") {
    const repositoryId = pageUrl.searchParams.get("repositoryId");
    if (repositoryId !== null) apiUrl.searchParams.set("repositoryId", repositoryId);
  }
  return { path: `${apiUrl.pathname}${apiUrl.search}`, implicitScope };
}

export function pageUrlForGraphScope(
  pageUrl: URL,
  scope: GraphNavigationScope,
  repositoryId?: string,
) {
  const next = new URL(pageUrl);
  next.searchParams.delete("showcase");
  next.searchParams.delete("fixture");
  next.searchParams.delete("node");
  next.searchParams.set("scope", scope);
  if (scope === "repository" && repositoryId) {
    next.searchParams.set("repositoryId", repositoryId);
  } else {
    next.searchParams.delete("repositoryId");
  }
  return next;
}

export function pageUrlForCurrentGraph(
  pageUrl: URL,
  returnState?: GraphPresentationReturnState | null,
) {
  const next = new URL(pageUrl);
  const hadPresentation = next.searchParams.has("showcase") || next.searchParams.has("fixture");
  next.searchParams.delete("showcase");
  next.searchParams.delete("fixture");
  if (hadPresentation && !next.searchParams.has("scope")) {
    next.searchParams.set("scope", "corpus");
    next.searchParams.delete("repositoryId");
  }
  if (returnState) {
    next.searchParams.set("view", returnState.viewMode);
    if (returnState.viewMode === "orbit" && returnState.selectedNodeId) {
      next.searchParams.set("node", returnState.selectedNodeId);
    } else {
      next.searchParams.delete("node");
    }
  } else if (hadPresentation) {
    next.searchParams.set("view", "constellation");
    next.searchParams.delete("node");
  }
  return next;
}

export function repositoryIdFromNodeId(nodeId: string) {
  const match = /^repository:github:([1-9][0-9]*)$/.exec(nodeId);
  return match?.[1] ?? null;
}
