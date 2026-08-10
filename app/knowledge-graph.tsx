"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
} from "d3-force-3d";
import {
  domainLabels,
  nodeKindLabels,
  relationLabels,
  type Domain,
  type KnowledgeEdge,
  type KnowledgeNode,
  type NodeKind,
  type RelationLayer,
  type RelationKind,
} from "./graph-data";
import type {
  GraphDocumentSummary,
  GraphNodeSearchResult,
  GraphSnapshot,
} from "./lib/graph/model";
import { analyzeGraphSnapshot } from "./lib/graph/analytics";
import { createPerformanceGraphSnapshot } from "./lib/graph/performance-fixture";
import {
  loadPublicGoldGraphSnapshot,
  loadPublicGraphSnapshot,
} from "./lib/graph/public-graph-client";
import {
  GRAPH_REVISION_STORAGE_KEY,
  shouldRefreshGraphRevision,
} from "./lib/graph/graph-revision";
import {
  graphApiRequestFromPageUrl,
  graphScopeHistoryStateFromHistoryState,
  historyStateWithGraphScopeState,
  pageUrlForCurrentGraph,
  pageUrlForGraphScope,
  repositoryIdFromNodeId,
  type GraphNavigationScope,
  type GraphScopeHistoryState,
} from "./lib/graph/scope-navigation";
import {
  calculateLayout,
  mostConnectedNodeId,
  type GraphViewMode,
  type LayoutResult,
  type PositionTuple,
} from "./graph/layouts";
import {
  luminosityPresetControls,
  resolveFocusContrast,
  resolveLuminosityControls,
  resolveLuminositySettings,
  type FocusContrast,
  type FocusContrastSettings,
  type LuminosityControls,
  type LuminosityPreset,
  type LuminositySettings,
} from "./graph/luminosity";
import {
  buildFilteredFocus,
  buildSelectionFocus,
  emptyFocusState,
  EXPANDED_FOCUS_VISIBILITY,
  graphEdgeId as edgeId,
  type FocusState,
} from "./graph/focus";
import {
  resolveLabelLod,
  scoreLabelCandidate,
  selectLabelIds,
  type LabelFocusTier,
  type LabelLod,
} from "./graph/label-lod";
import {
  resolveLabelCollisions,
  type ScreenLabelCandidate,
} from "./graph/label-collision";
import {
  orbitDepthAnchor,
  orbitDepthDescriptors,
  type OrbitDepthKey,
} from "./graph/orbit-depth";
import {
  autoRotateSpeed,
  autoRotateStatusText,
  initialAutoRotateIntent,
  reconcileAutoRotateMotionPreference,
  toggleAutoRotateIntent,
  type AutoRotateIntent,
} from "./graph/auto-rotate";

type SimNode = KnowledgeNode & {
  x?: number;
  y?: number;
  z?: number;
  vx?: number;
  vy?: number;
  vz?: number;
};

type SimEdge = Omit<KnowledgeEdge, "source" | "target"> & {
  source: string | SimNode;
  target: string | SimNode;
};

type RenderQuality = "high" | "balanced" | "low";

type PerformanceMetrics = {
  fps: number;
  p95FrameMs: number;
  quality: RenderQuality;
  drawCalls: number;
  geometries: number;
  heapMb?: number;
};

type GraphApi = {
  reset: () => void;
  flyTo: (id: string) => void;
  setAutoRotate: (value: boolean, speed: number) => void;
  setLabelsVisible: (value: boolean) => void;
  setViewMode: (mode: GraphViewMode, selectedId?: string | null) => void;
  setLuminosity: (preset: LuminosityPreset) => void;
  setLuminosityControls?: (controls: LuminosityControls) => void;
};

type ShowcaseState = {
  viewMode: GraphViewMode;
  activeLens: string;
  activeDomains: Domain[];
  activeKinds: NodeKind[];
  activeRelations: RelationKind[];
  selectedId: string | null;
  autoRotateIntent: AutoRotateIntent;
  labelsVisible: boolean;
  luminosity: LuminosityPreset;
  luminosityControls: LuminosityControls;
  savedCustomControls: LuminosityControls | null;
  luminosityCustom: boolean;
};

export type GraphDataMode = "api" | "public-static";

type KnowledgeGraphProps = {
  dataMode?: GraphDataMode;
};

declare const __ATLAS_PUBLIC_STATIC_BUILD__: boolean | undefined;

const PUBLIC_STATIC_BUILD = typeof __ATLAS_PUBLIC_STATIC_BUILD__ !== "undefined"
  && __ATLAS_PUBLIC_STATIC_BUILD__;

const VIEW_LABELS: Record<GraphViewMode, string> = {
  constellation: "별자리",
  nebula: "성운",
  orbit: "궤도",
};

const LUMINOSITY_LABELS: Record<LuminosityPreset, string> = {
  normal: "기본",
  bright: "브라이트",
  supernova: "초신성",
};

// Keep the floating source chooser away from both viewport edges.  The same
// values are mirrored in `.data-source-panel` so its measured placement and
// rendered width never disagree on narrow screens.
const DATA_SOURCE_PANEL_MAX_WIDTH = 310;
const DATA_SOURCE_PANEL_GUTTER = 20;

const NODE_COLORS: Record<NodeKind, number> = {
  thesis: 0xff473d,
  concept: 0xefe8d8,
  system: 0x9f7aea,
  tool: 0x65b5ff,
  practice: 0xf3b35b,
  risk: 0xff6678,
};

const DOMAIN_COLORS: Record<Domain, string> = {
  reasoning: "#efe8d8",
  agents: "#9f7aea",
  memory: "#65b5ff",
  safety: "#ff6678",
  product: "#f3b35b",
  infrastructure: "#79d5c0",
};

const NODE_SIZES: Record<NodeKind, number> = {
  thesis: 18,
  concept: 10,
  system: 14,
  tool: 11,
  practice: 11,
  risk: 12,
};

const RELATION_STYLES: Record<
  RelationKind,
  { color: string; dash: string }
> = {
  documents: { color: "#f5e6b3", dash: "solid" },
  plans: { color: "#d8a7ff", dash: "solid" },
  contains: { color: "#a4c8ff", dash: "short" },
  implements: { color: "#79d5c0", dash: "solid" },
  depends_on: { color: "#65b5ff", dash: "short" },
  calls: { color: "#70d7ff", dash: "short" },
  reads_from: { color: "#8bbcff", dash: "short" },
  writes_to: { color: "#f3b35b", dash: "short" },
  produces: { color: "#9be1c7", dash: "solid" },
  tests: { color: "#b9dc7a", dash: "solid" },
  references: { color: "#b8bec8", dash: "short" },
  precedes: { color: "#b99aff", dash: "solid" },
  blocks: { color: "#ff6678", dash: "long" },
  supersedes: { color: "#f29b67", dash: "long" },
  same_as: { color: "#e8e4dc", dash: "short" },
  mentions: { color: "#8f98a5", dash: "short" },
  related_to: { color: "#a99ad8", dash: "short" },
  supports: { color: "#d8d1c1", dash: "solid" },
  extends: { color: "#9f7aea", dash: "solid" },
  requires: { color: "#65b5ff", dash: "short" },
  uses: { color: "#79d5c0", dash: "short" },
  mitigates: { color: "#f3b35b", dash: "solid" },
  risks: { color: "#ff6678", dash: "long" },
  contradicts: { color: "#ff473d", dash: "long" },
};

const RELATION_LAYER_LABELS: Record<RelationLayer, string> = {
  structural: "구조",
  explicit: "명시",
  inferred: "추론",
  display: "화면",
};

const RELATION_LAYER_STYLES: Record<RelationLayer, { color: string; dash: string }> = {
  structural: { color: "#7186a3", dash: "solid" },
  explicit: { color: "#d8f2ff", dash: "solid" },
  inferred: { color: "#c7a5ff", dash: "short" },
  display: { color: "#6c657c", dash: "long" },
};

const relationLayerForEdge = (edge: KnowledgeEdge): RelationLayer =>
  edge.layer
  ?? (edge.origin === "codex"
    ? "inferred"
    : edge.origin === "display"
      ? "display"
      : ["documents", "plans", "contains"].includes(edge.type)
        ? "structural"
        : "explicit");

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

function xorshift(seed: number) {
  let value = seed || 1;
  return () => {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    return ((value >>> 0) % 100000) / 100000;
  };
}

function createParticleGlowTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("입자 글로우 텍스처를 생성할 수 없습니다.");

  const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, "rgba(255, 255, 255, 1)");
  gradient.addColorStop(0.16, "rgba(255, 255, 255, 0.96)");
  gradient.addColorStop(0.38, "rgba(255, 255, 255, 0.58)");
  gradient.addColorStop(0.68, "rgba(255, 255, 255, 0.16)");
  gradient.addColorStop(1, "rgba(255, 255, 255, 0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 64, 64);

  const texture = new THREE.CanvasTexture(canvas);
  texture.name = "atlas-particle-soft-glow";
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  return texture;
}

function useSetToggle<T>(
  initial: T[] = [],
): [Set<T>, (value: T) => void, () => void, (values: readonly T[]) => void] {
  const [set, update] = useState(() => new Set(initial));
  const toggle = useCallback((value: T) => {
    update((current) => {
      const next = new Set(current);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  }, []);
  const clear = useCallback(() => update(new Set()), []);
  const replace = useCallback((values: readonly T[]) => update(new Set(values)), []);
  return [set, toggle, clear, replace];
}

export default function KnowledgeGraph({ dataMode = "api" }: KnowledgeGraphProps) {
  const publicStaticMode = PUBLIC_STATIC_BUILD || dataMode === "public-static";
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const graphApiRef = useRef<GraphApi | null>(null);
  const focusRef = useRef<FocusState>(emptyFocusState());
  const luminosityButtonRef = useRef<HTMLButtonElement>(null);
  const luminosityPanelRef = useRef<HTMLElement>(null);
  const dataMenuButtonRef = useRef<HTMLButtonElement>(null);
  const dataMenuPanelRef = useRef<HTMLElement>(null);
  const urlInitializedRef = useRef(false);
  const showcaseStateRef = useRef<ShowcaseState | null>(null);
  const shouldFitShowcaseRef = useRef(false);
  const viewModeRef = useRef<GraphViewMode>("constellation");
  const luminosityRef = useRef<LuminosityPreset>("bright");
  const luminosityPreviewRef = useRef(true);
  const luminosityControlsRef = useRef<LuminosityControls>({
    ...luminosityPresetControls.bright,
  });
  const selectedIdRef = useRef<string | null>(null);
  const autoRotateIntentRef = useRef<AutoRotateIntent>(initialAutoRotateIntent(false));
  const graphRevisionRef = useRef("");
  const graphLoadingRef = useRef(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hovered, setHovered] = useState<{
    id: string;
    x: number;
    y: number;
  } | null>(null);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [indexedSearchResults, setIndexedSearchResults] = useState<GraphNodeSearchResult[]>([]);
  const [indexedSearchLoading, setIndexedSearchLoading] = useState(false);
  const [recentDocuments, setRecentDocuments] = useState<GraphDocumentSummary[]>([]);
  const [autoRotateIntent, setAutoRotateIntent] = useState<AutoRotateIntent>(() =>
    initialAutoRotateIntent(false),
  );
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const [labelsVisible, setLabelsVisible] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [viewMode, setViewMode] = useState<GraphViewMode>("constellation");
  const [luminosity, setLuminosity] = useState<LuminosityPreset>("bright");
  const [luminosityControls, setLuminosityControls] = useState<LuminosityControls>(
    () => ({ ...luminosityPresetControls.bright }),
  );
  const [savedCustomControls, setSavedCustomControls] =
    useState<LuminosityControls | null>(null);
  const [luminosityCustom, setLuminosityCustom] = useState(false);
  const [luminosityPanelOpen, setLuminosityPanelOpen] = useState(false);
  const [dataMenuOpen, setDataMenuOpen] = useState(false);
  const [dataMenuPosition, setDataMenuPosition] = useState({ left: 12, bottom: 82 });
  const luminosityPreviewEnabled = true;
  const [graphLoading, setGraphLoading] = useState(true);
  const [graphError, setGraphError] = useState("");
  const [graphRequestedScope, setGraphRequestedScope] =
    useState<GraphNavigationScope | null>(null);
  const [performanceEnabled, setPerformanceEnabled] = useState(false);
  const [performanceMetrics, setPerformanceMetrics] = useState<PerformanceMetrics | null>(null);
  const autoRotate = autoRotateIntent.enabled;
  const currentAutoRotateSpeed = autoRotateSpeed(prefersReducedMotion);
  const autoRotateStatus = autoRotateStatusText(autoRotateIntent, prefersReducedMotion);

  const updateAutoRotateIntent = useCallback((next: AutoRotateIntent) => {
    autoRotateIntentRef.current = next;
    setAutoRotateIntent(next);
  }, []);
  const [graphData, setGraphData] = useState<GraphSnapshot>({
    nodes: [],
    edges: [],
    meta: {
      source: "demo",
      provider: "built-in",
      generatedAt: "",
    },
  });
  const [activeLens, setActiveLens] = useState("all");
  const [activeDomains, toggleDomain, clearDomains, replaceDomains] = useSetToggle<Domain>();
  const [activeKinds, toggleKind, clearKinds, replaceKinds] = useSetToggle<NodeKind>();
  const [activeRelations, toggleRelation, clearRelations, replaceRelations] =
    useSetToggle<RelationKind>();
  const [activeLayers, toggleLayer, clearLayers] = useSetToggle<RelationLayer>();

  const changeViewMode = useCallback(
    (nextMode: GraphViewMode) => {
      const nextSelected =
        nextMode === "orbit" && !selectedId
          ? mostConnectedNodeId(graphData.nodes, graphData.edges) ?? null
          : selectedId;
      if (nextMode === "orbit" && nextSelected && !selectedId) {
        setSelectedId(nextSelected);
      }
      setViewMode(nextMode);
      graphApiRef.current?.setViewMode(nextMode, nextSelected);
      const url = new URL(window.location.href);
      url.searchParams.set("view", nextMode);
      if (nextMode === "orbit" && nextSelected) url.searchParams.set("node", nextSelected);
      else url.searchParams.delete("node");
      window.history.replaceState({}, "", url);
    },
    [graphData.edges, graphData.nodes, selectedId],
  );

  const knowledgeNodes = graphData.nodes;
  const knowledgeEdges = graphData.edges;

  const graphScopeState = useCallback(
    (selectedNodeId = selectedId): GraphScopeHistoryState => ({
      selectedNodeId,
      activeLens,
      activeDomains: [...activeDomains],
      activeKinds: [...activeKinds],
      activeRelations: [...activeRelations],
    }),
    [activeDomains, activeKinds, activeLens, activeRelations, selectedId],
  );

  const restoreGraphScopeState = useCallback((state: GraphScopeHistoryState) => {
    const includesKey = <T extends string>(record: Record<T, unknown>, value: string): value is T =>
      Object.hasOwn(record, value);
    setActiveLens(state.activeLens);
    replaceDomains(state.activeDomains.filter((value): value is Domain =>
      includesKey(domainLabels, value),
    ));
    replaceKinds(state.activeKinds.filter((value): value is NodeKind =>
      includesKey(nodeKindLabels, value),
    ));
    replaceRelations(state.activeRelations.filter((value): value is RelationKind =>
      includesKey(relationLabels, value),
    ));
  }, [replaceDomains, replaceKinds, replaceRelations]);

  const loadGraph = useCallback(async () => {
    graphLoadingRef.current = true;
    setGraphLoading(true);
    setGraphError("");
    try {
      const pageUrl = new URL(window.location.href);
      const presentationFixture = pageUrl.searchParams.has("showcase")
        || pageUrl.searchParams.has("fixture");
      const savedScopeState = presentationFixture
        ? null
        : graphScopeHistoryStateFromHistoryState(window.history.state);
      setGraphRequestedScope(
        presentationFixture
          ? null
          : publicStaticMode
            ? "corpus"
          : pageUrl.searchParams.get("scope") === "repository"
            ? "repository"
            : pageUrl.searchParams.get("scope") === "document"
              ? "document"
            : pageUrl.searchParams.get("scope") === "overview"
              ? "overview"
              : "corpus",
      );
      let payload: GraphSnapshot;
      let implicitScope = false;
      if (publicStaticMode) {
        const showcase = pageUrl.searchParams.get("showcase");
        const fixture = pageUrl.searchParams.get("fixture");
        if (showcase === "max" || fixture === "500x2000") {
          payload = analyzeGraphSnapshot(createPerformanceGraphSnapshot());
        } else if (showcase === "gold" || fixture === "gold-v1") {
          payload = await loadPublicGoldGraphSnapshot();
        } else {
          payload = (await loadPublicGraphSnapshot()).snapshot;
          implicitScope = pageUrl.searchParams.get("scope") !== "corpus";
          pageUrl.searchParams.set("scope", "corpus");
          pageUrl.searchParams.delete("repositoryId");
          pageUrl.searchParams.delete("documentId");
        }
      } else {
        const graphRequest = graphApiRequestFromPageUrl(pageUrl);
        implicitScope = graphRequest.implicitScope;
        const response = await fetch(graphRequest.path, { cache: "no-store" });
        const responsePayload = (await response.json()) as GraphSnapshot & { error?: string };
        if (!response.ok) {
          throw new Error(responsePayload.error || `그래프 요청 실패 (${response.status})`);
        }
        payload = responsePayload;
      }
      if (!Array.isArray(payload.nodes) || !Array.isArray(payload.edges)) {
        throw new Error("그래프 응답 형식이 올바르지 않습니다.");
      }
      if (implicitScope && payload.meta.scope) {
        pageUrl.searchParams.set("scope", payload.meta.scope);
        window.history.replaceState({}, "", pageUrl);
      }
      if (savedScopeState) restoreGraphScopeState(savedScopeState);
      const requestedNode = pageUrl.searchParams.get("node") ?? savedScopeState?.selectedNodeId;
      setSelectedId(
        requestedNode && payload.nodes.some((node) => node.id === requestedNode)
          ? requestedNode
          : null,
      );
      setGraphRequestedScope(payload.meta.scope ?? null);
      graphRevisionRef.current = payload.meta.graphRevision ?? "";
      setGraphData(payload);
    } catch (error) {
      setGraphError(error instanceof Error ? error.message : "그래프를 불러오지 못했습니다.");
    } finally {
      graphLoadingRef.current = false;
      setGraphLoading(false);
    }
  }, [publicStaticMode, restoreGraphScopeState]);

  const navigateGraphScope = useCallback(
    async (scope: GraphNavigationScope, resourceId?: string, focusNodeId?: string) => {
      const nextUrl = pageUrlForGraphScope(
        new URL(window.location.href),
        scope,
        resourceId,
      );
      if (focusNodeId) {
        nextUrl.searchParams.set("view", "orbit");
        nextUrl.searchParams.set("node", focusNodeId);
      }
      window.history.replaceState(
        historyStateWithGraphScopeState(window.history.state, graphScopeState()),
        "",
        window.location.href,
      );
      window.history.pushState(
        historyStateWithGraphScopeState(null, graphScopeState(null)),
        "",
        nextUrl,
      );
      setSelectedId(focusNodeId ?? null);
      if (focusNodeId) {
        setViewMode("orbit");
        viewModeRef.current = "orbit";
      }
      setHovered(null);
      setQuery("");
      setSearchOpen(false);
      setDataMenuOpen(false);
      await loadGraph();
      if (focusNodeId) graphApiRef.current?.setViewMode("orbit", focusNodeId);
    },
    [graphScopeState, loadGraph],
  );

  const positionDataMenu = useCallback(() => {
    const bounds = dataMenuButtonRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const panelWidth = Math.min(
      DATA_SOURCE_PANEL_MAX_WIDTH,
      window.innerWidth - DATA_SOURCE_PANEL_GUTTER * 2,
    );
    setDataMenuPosition({
      left: clamp(
        bounds.left,
        DATA_SOURCE_PANEL_GUTTER,
        window.innerWidth - panelWidth - DATA_SOURCE_PANEL_GUTTER,
      ),
      bottom: window.innerHeight - bounds.top + 8,
    });
  }, []);

  const toggleDataMenu = () => {
    if (dataMenuOpen) {
      setDataMenuOpen(false);
      return;
    }
    positionDataMenu();
    setDataMenuOpen(true);
  };

  const captureShowcaseState = useCallback(() => {
    showcaseStateRef.current = {
      viewMode,
      activeLens,
      activeDomains: [...activeDomains],
      activeKinds: [...activeKinds],
      activeRelations: [...activeRelations],
      selectedId,
      autoRotateIntent: { ...autoRotateIntent },
      labelsVisible,
      luminosity,
      luminosityControls: { ...luminosityControls },
      savedCustomControls: savedCustomControls ? { ...savedCustomControls } : null,
      luminosityCustom,
    };
  }, [
    activeDomains,
    activeKinds,
    activeLens,
    activeRelations,
    autoRotateIntent,
    labelsVisible,
    luminosity,
    luminosityControls,
    luminosityCustom,
    savedCustomControls,
    selectedId,
    viewMode,
  ]);

  const applyShowcasePresentation = useCallback(() => {
    setActiveLens("all");
    clearDomains();
    clearKinds();
    clearRelations();
    setSelectedId(null);
    setViewMode("constellation");
    updateAutoRotateIntent(initialAutoRotateIntent(prefersReducedMotion));
    setLabelsVisible(false);
    setLuminosity("supernova");
    setLuminosityControls({ ...luminosityPresetControls.supernova });
    setSavedCustomControls(null);
    setLuminosityCustom(false);
    setLuminosityPanelOpen(false);
    shouldFitShowcaseRef.current = true;
  }, [clearDomains, clearKinds, clearRelations, prefersReducedMotion, updateAutoRotateIntent]);

  const applyGoldPresentation = useCallback(() => {
    setActiveLens("all");
    clearDomains();
    clearKinds();
    clearRelations();
    setSelectedId(null);
    setViewMode("constellation");
    updateAutoRotateIntent(initialAutoRotateIntent(prefersReducedMotion));
    setLabelsVisible(true);
    setLuminosity("bright");
    setLuminosityControls({ ...luminosityPresetControls.bright });
    setLuminosityCustom(false);
    setLuminosityPanelOpen(false);
    shouldFitShowcaseRef.current = true;
  }, [clearDomains, clearKinds, clearRelations, prefersReducedMotion, updateAutoRotateIntent]);

  const restoreShowcaseState = useCallback((state: ShowcaseState) => {
    setActiveLens(state.activeLens);
    replaceDomains(state.activeDomains);
    replaceKinds(state.activeKinds);
    replaceRelations(state.activeRelations);
    setSelectedId(state.selectedId);
    setViewMode(state.viewMode);
    updateAutoRotateIntent({ ...state.autoRotateIntent });
    setLabelsVisible(state.labelsVisible);
    setLuminosity(state.luminosity);
    setLuminosityControls({ ...state.luminosityControls });
    setSavedCustomControls(
      state.savedCustomControls ? { ...state.savedCustomControls } : null,
    );
    setLuminosityCustom(state.luminosityCustom);
    setLuminosityPanelOpen(false);
    showcaseStateRef.current = null;
  }, [replaceDomains, replaceKinds, replaceRelations, updateAutoRotateIntent]);

  const selectDataSource = useCallback(
    async (source: "current" | "corpus" | "overview" | "gold" | "max") => {
      let url = new URL(window.location.href);
      const currentShowcase = url.searchParams.get("showcase");
      const wasPresentation = currentShowcase === "max"
        || currentShowcase === "gold"
        || url.searchParams.has("fixture");
      const restoreState = source === "current" && wasPresentation
        ? showcaseStateRef.current
        : null;
      if (source === "max") {
        if (!wasPresentation) captureShowcaseState();
        applyShowcasePresentation();
        url.searchParams.set("showcase", "max");
        url.searchParams.set("view", "constellation");
      } else if (source === "gold") {
        if (!wasPresentation) captureShowcaseState();
        applyGoldPresentation();
        url.searchParams.set("showcase", "gold");
        url.searchParams.set("view", "constellation");
      } else if (source === "corpus" || source === "overview") {
        url = pageUrlForGraphScope(url, source);
        setSelectedId(null);
        setHovered(null);
        setQuery("");
        setSearchOpen(false);
      } else {
        url = pageUrlForCurrentGraph(
          url,
          restoreState
            ? { viewMode: restoreState.viewMode, selectedNodeId: restoreState.selectedId }
            : null,
        );
        if (!restoreState && wasPresentation) {
          setSelectedId(null);
          setViewMode("constellation");
          graphApiRef.current?.setViewMode("constellation", null);
        }
      }
      url.searchParams.delete("fixture");
      if (source !== "current") url.searchParams.delete("node");
      window.history.replaceState({}, "", url);
      setDataMenuOpen(false);
      await loadGraph();
      if (restoreState) restoreShowcaseState(restoreState);
      dataMenuButtonRef.current?.focus();
    },
    [applyGoldPresentation, applyShowcasePresentation, captureShowcaseState, loadGraph, restoreShowcaseState],
  );

  useEffect(() => {
    const initialShowcase = new URL(window.location.href).searchParams.get("showcase");
    luminosityPreviewRef.current = true;
    const frame = window.requestAnimationFrame(() => {
      if (initialShowcase === "max") applyShowcasePresentation();
      if (initialShowcase === "gold") applyGoldPresentation();
      setPerformanceEnabled(new URL(window.location.href).searchParams.get("perf") === "1");
      void loadGraph();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [applyGoldPresentation, applyShowcasePresentation, loadGraph]);

  useEffect(() => {
    const onPopState = () => void loadGraph();
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [loadGraph]);

  useEffect(() => {
    if (publicStaticMode) return;
    let disposed = false;
    const presentationActive = () => {
      const url = new URL(window.location.href);
      return url.searchParams.has("showcase") || url.searchParams.has("fixture");
    };
    const refreshIfChanged = async (announcedRevision?: string) => {
      if (disposed || presentationActive() || graphLoadingRef.current) return;
      try {
        const nextRevision = announcedRevision || (await (async () => {
          const response = await fetch("/api/graph/revision", { cache: "no-store" });
          if (!response.ok) return "";
          const payload = await response.json() as { graphRevision?: string };
          return payload.graphRevision ?? "";
        })());
        if (shouldRefreshGraphRevision(graphRevisionRef.current, nextRevision)) {
          await loadGraph();
        }
      } catch {
        // The full graph loader owns user-visible errors. A lightweight
        // revision probe may fail transiently without replacing the graph.
      }
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key !== GRAPH_REVISION_STORAGE_KEY || !event.newValue) return;
      try {
        const payload = JSON.parse(event.newValue) as { graphRevision?: string };
        void refreshIfChanged(payload.graphRevision);
      } catch {
        // Ignore malformed cross-tab notifications and keep polling.
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void refreshIfChanged();
    };
    const interval = window.setInterval(() => void refreshIfChanged(), 5_000);
    window.addEventListener("storage", onStorage);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      disposed = true;
      window.clearInterval(interval);
      window.removeEventListener("storage", onStorage);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [loadGraph, publicStaticMode]);

  useEffect(() => {
    if (!graphData.meta.generatedAt) return;
    window.history.replaceState(
      historyStateWithGraphScopeState(window.history.state, graphScopeState()),
      "",
      window.location.href,
    );
  }, [graphData.meta.generatedAt, graphScopeState]);

  useEffect(() => {
    if (publicStaticMode) return;
    const controller = new AbortController();
    void fetch("/api/graph/documents?limit=6", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) return;
        const payload = await response.json() as { documents?: GraphDocumentSummary[] };
        if (Array.isArray(payload.documents)) setRecentDocuments(payload.documents);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [graphData.meta.graphRevision, publicStaticMode]);

  useEffect(() => {
    const normalized = query.trim();
    if (publicStaticMode) return;
    if (normalized.length < 2) {
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setIndexedSearchLoading(true);
      void fetch(`/api/graph/search?q=${encodeURIComponent(normalized)}&limit=8`, {
        cache: "no-store",
        signal: controller.signal,
      })
        .then(async (response) => {
          const payload = await response.json() as { results?: GraphNodeSearchResult[] };
          setIndexedSearchResults(response.ok && Array.isArray(payload.results) ? payload.results : []);
        })
        .catch(() => {
          if (!controller.signal.aborted) setIndexedSearchResults([]);
        })
        .finally(() => {
          if (!controller.signal.aborted) setIndexedSearchLoading(false);
        });
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [publicStaticMode, query]);

  const nodeMap = useMemo(
    () => new Map(knowledgeNodes.map((nodeItem) => [nodeItem.id, nodeItem])),
    [knowledgeNodes],
  );

  const degreeMap = useMemo(() => {
    const map = new Map<string, number>();
    knowledgeNodes.forEach((item) => map.set(item.id, 0));
    knowledgeEdges.forEach((item) => {
      map.set(item.source, (map.get(item.source) ?? 0) + 1);
      map.set(item.target, (map.get(item.target) ?? 0) + 1);
    });
    return map;
  }, [knowledgeEdges, knowledgeNodes]);

  const domainCounts = useMemo(() => {
    const counts = new Map<Domain, number>();
    knowledgeNodes.forEach((item) =>
      counts.set(item.domain, (counts.get(item.domain) ?? 0) + 1),
    );
    return counts;
  }, [knowledgeNodes]);

  const kindCounts = useMemo(() => {
    const counts = new Map<NodeKind, number>();
    knowledgeNodes.forEach((item) =>
      counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1),
    );
    return counts;
  }, [knowledgeNodes]);

  const relationCounts = useMemo(() => {
    const counts = new Map<RelationKind, number>();
    knowledgeEdges.forEach((item) =>
      counts.set(item.type, (counts.get(item.type) ?? 0) + 1),
    );
    return counts;
  }, [knowledgeEdges]);

  const relationLayerCounts = useMemo(() => {
    const counts = new Map<RelationLayer, number>();
    knowledgeEdges.forEach((edge) => {
      const layer = relationLayerForEdge(edge);
      counts.set(layer, (counts.get(layer) ?? 0) + 1);
    });
    return counts;
  }, [knowledgeEdges]);

  const selectedNode = selectedId ? nodeMap.get(selectedId) ?? null : null;
  const showcaseActive = graphData.meta.provider === "performance-fixture";
  const goldGraphActive = graphData.meta.provider === "gold-graph-fixture";
  const presentationFixtureActive = showcaseActive || goldGraphActive;
  const corpusScopeActive = !presentationFixtureActive && graphData.meta.scope === "corpus";
  const overviewScopeActive = !presentationFixtureActive && graphData.meta.scope === "overview";
  const repositoryScopeActive = !presentationFixtureActive && graphData.meta.scope === "repository";
  const documentScopeActive = !presentationFixtureActive && graphData.meta.scope === "document";
  const repositoryScopeContext = repositoryScopeActive
    || (Boolean(graphError) && graphRequestedScope === "repository");
  const documentScopeContext = documentScopeActive
    || (Boolean(graphError) && graphRequestedScope === "document");
  const currentRepositoryNode = graphData.meta.repositoryId
    ? nodeMap.get(`repository:github:${graphData.meta.repositoryId}`) ?? null
    : null;
  const selectedRepositoryId = selectedNode
    ? repositoryIdFromNodeId(selectedNode.id)
    : null;
  const selectedTaskStatus = selectedNode?.tags.includes("task")
    ? selectedNode.tags.includes("completed")
      ? "completed"
      : selectedNode.tags.includes("pending")
        ? "pending"
        : "unknown"
    : null;

  useEffect(() => {
    if (!presentationFixtureActive || !shouldFitShowcaseRef.current) return;
    let innerFrame: number | undefined;
    const outerFrame = window.requestAnimationFrame(() => {
      innerFrame = window.requestAnimationFrame(() => {
        graphApiRef.current?.reset();
        shouldFitShowcaseRef.current = false;
      });
    });
    return () => {
      window.cancelAnimationFrame(outerFrame);
      if (innerFrame !== undefined) window.cancelAnimationFrame(innerFrame);
    };
  }, [graphData, presentationFixtureActive]);

  const controlDataStatus = graphLoading
    ? "SYNC"
    : graphError
      ? "ERROR"
      : goldGraphActive
        ? `GOLD SAMPLE ${knowledgeNodes.length}N`
      : showcaseActive
      ? `MAX ${knowledgeNodes.length}N`
      : repositoryScopeActive
        ? `REPO ${knowledgeNodes.length}N`
        : documentScopeActive
          ? `DOC ${knowledgeNodes.length}N/${knowledgeEdges.length}E`
        : corpusScopeActive
          ? `${publicStaticMode ? "PUBLIC" : "D1"} ${knowledgeNodes.length}N/${knowledgeEdges.length}E`
        : overviewScopeActive
          ? `MAP ${graphData.meta.repositoryCount ?? 0}R`
          : graphData.meta.source === "documents"
            ? `DOCS ${graphData.meta.documentCount ?? 0}`
            : `DEMO ${knowledgeNodes.length}N`;
  const controlLuminosityStatus = luminosityCustom
    ? `커스텀 ${luminosityControls.overall}%`
    : LUMINOSITY_LABELS[luminosity];
  const controlStatusLabel = `${VIEW_LABELS[viewMode]} · ${controlDataStatus} · ${controlLuminosityStatus}`;

  const connectedItems = useMemo(() => {
    if (!selectedId) return [];
    return knowledgeEdges
      .filter((item) => item.source === selectedId || item.target === selectedId)
      .map((item) => {
        const outgoing = item.source === selectedId;
        const otherId = outgoing ? item.target : item.source;
        return {
          edge: item,
          outgoing,
          node: nodeMap.get(otherId),
        };
      })
      .filter((item) => item.node)
      .sort((a, b) => b.edge.confidence - a.edge.confidence);
  }, [knowledgeEdges, nodeMap, selectedId]);

  const searchResults = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return [];
    const localResults = knowledgeNodes
      .filter((item) =>
        [item.label, item.summary, item.tags.join(" ")]
          .join(" ")
          .toLowerCase()
          .includes(normalized),
      )
      .sort(
        (a, b) => (degreeMap.get(b.id) ?? 0) - (degreeMap.get(a.id) ?? 0),
      )
      .slice(0, 8)
      .map((node) => ({
        node,
        score: 1,
        document: undefined,
        inCurrentProjection: true,
      }));
    if (indexedSearchResults.length > 0) {
      return indexedSearchResults.map((result) => ({
        ...result,
        inCurrentProjection: nodeMap.has(result.node.id),
      })).slice(0, 8);
    }
    return localResults.slice(0, 8);
  }, [degreeMap, indexedSearchResults, knowledgeNodes, nodeMap, query]);

  const applyLens = useCallback(
    (lens: string) => {
      setActiveLens(lens);
      clearDomains();
      clearKinds();
      clearRelations();
      clearLayers();
      setSelectedId(null);

      const lensDomains: Record<string, Domain[]> = {
        agents: ["agents"],
        memory: ["memory"],
        safety: ["safety"],
        product: ["product"],
      };

      (lensDomains[lens] ?? []).forEach(toggleDomain);
    },
    [clearDomains, clearKinds, clearLayers, clearRelations, toggleDomain],
  );

  const selectNode = useCallback((id: string) => {
    setSelectedId(id);
    setQuery("");
    setSearchOpen(false);
    setSidebarOpen(false);
    if (viewModeRef.current === "orbit") {
      const url = new URL(window.location.href);
      url.searchParams.set("view", "orbit");
      url.searchParams.set("node", id);
      window.history.replaceState({}, "", url);
    } else {
      graphApiRef.current?.flyTo(id);
    }
  }, []);

  const openSearchResult = useCallback(async (
    result: GraphNodeSearchResult & { inCurrentProjection: boolean },
  ) => {
    if (!result.inCurrentProjection && result.document) {
      await navigateGraphScope("document", result.document.id, result.node.id);
      return;
    }
    setSelectedId(result.node.id);
    setQuery("");
    setSearchOpen(false);
    setSidebarOpen(false);
    setViewMode("orbit");
    viewModeRef.current = "orbit";
    graphApiRef.current?.setViewMode("orbit", result.node.id);
    const url = new URL(window.location.href);
    url.searchParams.set("view", "orbit");
    url.searchParams.set("node", result.node.id);
    window.history.replaceState({}, "", url);
  }, [navigateGraphScope]);

  useEffect(() => {
    const nodeIds = new Set<string>();
    const edgeIds = new Set<string>();
    const hasFilters =
      activeDomains.size > 0 ||
      activeKinds.size > 0 ||
      activeRelations.size > 0 ||
      activeLayers.size > 0;

    if (selectedId) {
      focusRef.current = buildSelectionFocus(knowledgeEdges, selectedId);
      return;
    }

    if (hasFilters) {
      knowledgeNodes.forEach((item) => {
        const domainMatch =
          activeDomains.size === 0 || activeDomains.has(item.domain);
        const kindMatch = activeKinds.size === 0 || activeKinds.has(item.kind);
        if (domainMatch && kindMatch) nodeIds.add(item.id);
      });

      knowledgeEdges.forEach((item) => {
        const relationMatch =
          activeRelations.size === 0 || activeRelations.has(item.type);
        const layerMatch =
          activeLayers.size === 0 || activeLayers.has(relationLayerForEdge(item));
        if (
          relationMatch && layerMatch &&
          (nodeIds.has(item.source) || nodeIds.has(item.target))
        ) {
          edgeIds.add(edgeId(item));
          nodeIds.add(item.source);
          nodeIds.add(item.target);
        }
      });
      focusRef.current = buildFilteredFocus(nodeIds, edgeIds);
      return;
    }

    focusRef.current = emptyFocusState();
  }, [activeDomains, activeKinds, activeLayers, activeRelations, knowledgeEdges, knowledgeNodes, selectedId, viewMode]);

  useEffect(() => {
    graphApiRef.current?.setAutoRotate(autoRotate, currentAutoRotateSpeed);
  }, [autoRotate, currentAutoRotateSpeed]);

  useEffect(() => {
    graphApiRef.current?.setLabelsVisible(labelsVisible);
  }, [labelsVisible]);

  useEffect(() => {
    selectedIdRef.current = selectedId;
    viewModeRef.current = viewMode;
    graphApiRef.current?.setViewMode(viewMode, selectedId);
  }, [selectedId, viewMode]);

  useEffect(() => {
    luminosityRef.current = luminosity;
    luminosityControlsRef.current = luminosityControls;
    if (luminosityPreviewEnabled) {
      graphApiRef.current?.setLuminosityControls?.(luminosityControls);
    } else {
      graphApiRef.current?.setLuminosity(luminosity);
    }
  }, [luminosity, luminosityControls, luminosityPreviewEnabled]);

  useEffect(() => {
    if (!luminosityPanelOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !luminosityButtonRef.current?.contains(target) &&
        !luminosityPanelRef.current?.contains(target)
      ) {
        setLuminosityPanelOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [luminosityPanelOpen]);

  useEffect(() => {
    if (!dataMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !dataMenuButtonRef.current?.contains(target) &&
        !dataMenuPanelRef.current?.contains(target)
      ) {
        setDataMenuOpen(false);
      }
    };
    window.addEventListener("resize", positionDataMenu);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("resize", positionDataMenu);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [dataMenuOpen, positionDataMenu]);

  useEffect(() => {
    if (urlInitializedRef.current) return;
    if (!graphData.meta.generatedAt) return;
    urlInitializedRef.current = true;
    const params = new URLSearchParams(window.location.search);
    const requestedView = params.get("view");
    const requestedNode = params.get("node");
    const frame = window.requestAnimationFrame(() => {
      if (requestedNode && graphData.nodes.some((node) => node.id === requestedNode)) {
        setSelectedId(requestedNode);
      }
      if (
        requestedView === "constellation" ||
        requestedView === "nebula" ||
        requestedView === "orbit"
      ) {
        setViewMode(requestedView);
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [graphData.meta.generatedAt, graphData.nodes]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTyping =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;
      if (event.key === "Escape") {
        if (dataMenuOpen) {
          setDataMenuOpen(false);
          dataMenuButtonRef.current?.focus();
          return;
        }
        if (luminosityPanelOpen) {
          setLuminosityPanelOpen(false);
          luminosityButtonRef.current?.focus();
          return;
        }
        setSelectedId(null);
        setSearchOpen(false);
        setSidebarOpen(false);
      } else if (!isTyping && event.key.toLowerCase() === "v") {
        const order: GraphViewMode[] = ["constellation", "nebula", "orbit"];
        const next = order[(order.indexOf(viewMode) + 1) % order.length];
        changeViewMode(next);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [changeViewMode, dataMenuOpen, luminosityPanelOpen, viewMode]);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const syncMotionPreference = () => {
      const nextReducedMotion = mediaQuery.matches;
      setPrefersReducedMotion(nextReducedMotion);
      updateAutoRotateIntent(reconcileAutoRotateMotionPreference(
        autoRotateIntentRef.current,
        nextReducedMotion,
      ));
    };
    syncMotionPreference();
    mediaQuery.addEventListener("change", syncMotionPreference);
    return () => mediaQuery.removeEventListener("change", syncMotionPreference);
  }, [updateAutoRotateIntent]);

  useEffect(() => {
    const host = canvasHostRef.current;
    if (!host) return;

    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const compact = window.matchMedia("(max-width: 760px)").matches;
    const luminosityPreviewEnabled = luminosityPreviewRef.current;
    const simNodes: SimNode[] = knowledgeNodes.map((item) => ({ ...item }));
    const simEdges: SimEdge[] = knowledgeEdges.map((item) => ({ ...item }));

    const simulation = forceSimulation<SimNode>(simNodes, 3)
      .force(
        "link",
        forceLink<SimNode, SimEdge>(simEdges)
          .id((item: SimNode) => item.id)
          .distance((item: SimEdge) =>
            item.type === "supports" || item.type === "requires" ? 58 : 72,
          )
          .strength(0.46),
      )
      .force("charge", forceManyBody<SimNode>().strength(-96))
      .force("center", forceCenter(0, 0, 0))
      .force(
        "collide",
        forceCollide<SimNode>((item) =>
          item.kind === "thesis" ? 18 : item.kind === "system" ? 12 : 8,
        ).strength(0.7),
      )
      .stop();

    simulation.tick(320);

    const positionsById = new Map<string, number>();
    simNodes.forEach((item, index) => positionsById.set(item.id, index));

    const radii = simNodes
      .map((item) => Math.hypot(item.x ?? 0, item.y ?? 0, item.z ?? 0))
      .sort((a, b) => a - b);
    const graphRadius = Math.max(
      120,
      radii[Math.floor(radii.length * 0.9)] ?? 160,
    );

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#07090b");

    const camera = new THREE.PerspectiveCamera(
      50,
      host.clientWidth / Math.max(1, host.clientHeight),
      0.5,
      graphRadius * 14,
    );
    const initialCameraPosition = new THREE.Vector3(
      graphRadius * 0.1,
      graphRadius * 0.18,
      graphRadius * 1.85,
    );
    camera.position.copy(initialCameraPosition);

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, compact ? 1.5 : 2));
    renderer.setSize(host.clientWidth, Math.max(1, host.clientHeight));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.domElement.setAttribute("aria-hidden", "true");
    host.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.065;
    controls.autoRotate = autoRotateIntentRef.current.enabled;
    controls.autoRotateSpeed = autoRotateSpeed(reducedMotion);
    controls.minDistance = graphRadius * 0.35;
    controls.maxDistance = graphRadius * 4.2;

    const nodeCount = simNodes.length;
    const edgeCount = simEdges.length;
    const baseNodePositions = new Float32Array(nodeCount * 3);
    const layoutFromPositions = new Float32Array(nodeCount * 3);
    const layoutTargetPositions = new Float32Array(nodeCount * 3);
    const animatedNodePositions = new Float32Array(nodeCount * 3);
    const constellationPositions: PositionTuple[] = [];
    const nodeColors = new Float32Array(nodeCount * 3);
    const nodeSizes = new Float32Array(nodeCount);
    const nodeSeeds = new Float32Array(nodeCount);
    const nodeBoosts = new Float32Array(nodeCount).fill(1);
    const nodeMotion = new Float32Array(nodeCount * 7);
    const nodeDegrees = new Float32Array(nodeCount);
    const random = xorshift(240817);
    const color = new THREE.Color();

    knowledgeEdges.forEach((item) => {
      const sourceIndex = positionsById.get(item.source);
      const targetIndex = positionsById.get(item.target);
      if (sourceIndex !== undefined) nodeDegrees[sourceIndex] += 1;
      if (targetIndex !== undefined) nodeDegrees[targetIndex] += 1;
    });

    simNodes.forEach((item, index) => {
      const x = item.x ?? 0;
      const y = item.y ?? 0;
      const z = item.z ?? 0;
      baseNodePositions.set([x, y, z], index * 3);
      layoutFromPositions.set([x, y, z], index * 3);
      layoutTargetPositions.set([x, y, z], index * 3);
      animatedNodePositions.set([x, y, z], index * 3);
      constellationPositions.push([x, y, z]);
      color.setHex(NODE_COLORS[item.kind]);
      nodeColors.set([color.r, color.g, color.b], index * 3);
      nodeSizes[index] = NODE_SIZES[item.kind];
      nodeSeeds[index] = random() * Math.PI * 2;
      nodeMotion.set(
        [
          0.18 + random() * 0.32,
          random() * Math.PI * 2,
          0.18 + random() * 0.32,
          random() * Math.PI * 2,
          0.18 + random() * 0.32,
          random() * Math.PI * 2,
          graphRadius * (item.kind === "thesis" ? 0.0045 : 0.009),
        ],
        index * 7,
      );
    });

    const nodeGeometry = new THREE.BufferGeometry();
    nodeGeometry.setAttribute(
      "position",
      new THREE.BufferAttribute(animatedNodePositions, 3),
    );
    nodeGeometry.setAttribute("color", new THREE.BufferAttribute(nodeColors, 3));
    nodeGeometry.setAttribute("size", new THREE.BufferAttribute(nodeSizes, 1));
    nodeGeometry.setAttribute("seed", new THREE.BufferAttribute(nodeSeeds, 1));
    nodeGeometry.setAttribute(
      "boost",
      new THREE.BufferAttribute(nodeBoosts, 1),
    );

    const nodeMaterial = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexColors: true,
      uniforms: {
        uTime: { value: 0 },
        uNear: { value: graphRadius * 0.25 },
        uFar: { value: graphRadius * 4.4 },
        uBreath: { value: reducedMotion ? 0 : 1 },
        uLuminosity: { value: 1.28 },
        uOutputCeiling: { value: 2.5 },
        uSafeOutput: { value: 0 },
        uViewScale: { value: 1 },
      },
      vertexShader: `
        attribute float size;
        attribute float seed;
        attribute float boost;
        varying vec3 vColor;
        varying float vFade;
        varying float vBoost;
        uniform float uTime;
        uniform float uNear;
        uniform float uFar;
        uniform float uBreath;
        uniform float uLuminosity;
        uniform float uViewScale;

        void main() {
          vColor = color;
          vBoost = boost;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          float breath = 1.0 + 0.10 * uBreath * sin(uTime * 0.9 + seed);
          gl_PointSize = size * breath * (420.0 / -mvPosition.z) * clamp(boost, 1.0, 1.58) * uViewScale * mix(0.96, 1.16, clamp(uLuminosity - 0.9, 0.0, 1.0));
          vFade = max(0.16, 1.0 - smoothstep(uNear, uFar, -mvPosition.z));
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `
        varying vec3 vColor;
        varying float vFade;
        varying float vBoost;
        uniform float uLuminosity;
        uniform float uOutputCeiling;
        uniform float uSafeOutput;

        void main() {
          vec2 uv = gl_PointCoord - 0.5;
          float distanceFromCenter = length(uv) * 2.0;
          if (distanceFromCenter > 1.0) discard;
          float core = smoothstep(0.24, 0.0, distanceFromCenter) * 1.45;
          float corona = smoothstep(0.72, 0.12, distanceFromCenter) * 0.54;
          float halo = smoothstep(1.0, 0.32, distanceFromCenter) * 0.24;
          float rayX = smoothstep(0.065, 0.0, abs(uv.x)) * smoothstep(0.72, 0.08, abs(uv.y));
          float rayY = smoothstep(0.065, 0.0, abs(uv.y)) * smoothstep(0.72, 0.08, abs(uv.x));
          float sparkle = (rayX + rayY) * 0.22 * max(0.0, uLuminosity - 1.0);
          float alpha = (core + corona + halo + sparkle) * vFade * min(vBoost, 2.2) * uLuminosity;
          vec3 whiteCore = mix(vColor, vec3(1.0), smoothstep(0.26, 0.0, distanceFromCenter));
          vec3 rawOutputColor = whiteCore * vBoost * uLuminosity;
          vec3 outputColor = mix(
            rawOutputColor,
            min(rawOutputColor, vec3(uOutputCeiling)),
            uSafeOutput
          );
          gl_FragColor = vec4(outputColor, min(alpha, 1.0));
        }
      `,
    });
    const nodePoints = new THREE.Points(nodeGeometry, nodeMaterial);
    scene.add(nodePoints);

    const createBeaconTexture = (kind: "corona" | "ring") => {
      const canvas = document.createElement("canvas");
      canvas.width = 192;
      canvas.height = 192;
      const context = canvas.getContext("2d");
      if (!context) return new THREE.CanvasTexture(canvas);
      const center = canvas.width / 2;

      if (kind === "corona") {
        const gradient = context.createRadialGradient(
          center,
          center,
          10,
          center,
          center,
          88,
        );
        gradient.addColorStop(0, "rgba(255,255,255,0.3)");
        gradient.addColorStop(0.26, "rgba(255,255,255,0.14)");
        gradient.addColorStop(0.58, "rgba(255,255,255,0.045)");
        gradient.addColorStop(1, "rgba(255,255,255,0)");
        context.fillStyle = gradient;
        context.fillRect(0, 0, canvas.width, canvas.height);
      } else {
        context.strokeStyle = "rgba(255,255,255,0.92)";
        context.lineWidth = 3;
        context.shadowColor = "rgba(255,255,255,0.72)";
        context.shadowBlur = 12;
        context.beginPath();
        context.arc(center, center, 70, 0, Math.PI * 2);
        context.stroke();

        context.lineWidth = 2;
        context.shadowBlur = 7;
        for (let index = 0; index < 4; index += 1) {
          const angle = index * (Math.PI / 2);
          const inner = 77;
          const outer = 86;
          context.beginPath();
          context.moveTo(
            center + Math.cos(angle) * inner,
            center + Math.sin(angle) * inner,
          );
          context.lineTo(
            center + Math.cos(angle) * outer,
            center + Math.sin(angle) * outer,
          );
          context.stroke();
        }
      }

      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.needsUpdate = true;
      return texture;
    };

    const beaconCoronaTexture = createBeaconTexture("corona");
    const beaconRingTexture = createBeaconTexture("ring");
    const beaconCoronaMaterial = new THREE.SpriteMaterial({
      map: beaconCoronaTexture,
      color: 0xa8d8ff,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    });
    const beaconRingMaterial = new THREE.SpriteMaterial({
      map: beaconRingTexture,
      color: 0xdaf1ff,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    });
    const beaconCorona = new THREE.Sprite(beaconCoronaMaterial);
    const beaconRing = new THREE.Sprite(beaconRingMaterial);
    const beaconNodeColor = new THREE.Color();
    const beaconWhite = new THREE.Color(0xffffff);
    const beaconCoolWhite = new THREE.Color(0xbfe7ff);
    beaconCorona.visible = false;
    beaconRing.visible = false;
    beaconCorona.renderOrder = 4;
    beaconRing.renderOrder = 5;
    scene.add(beaconCorona, beaconRing);

    const edgePositions = new Float32Array(edgeCount * 6);
    const edgeColors = new Float32Array(edgeCount * 6);
    const baseEdgeColors = new Float32Array(edgeCount * 6);
    const edgeProgress = new Float32Array(edgeCount * 2);
    const edgeLayers = new Float32Array(edgeCount * 2);
    const edgeIndexData = new Int32Array(edgeCount * 2);
    const edgePulse = new Float32Array(edgeCount * 2);

    simEdges.forEach((item, index) => {
      const sourceId =
        typeof item.source === "string" ? item.source : item.source.id;
      const targetId =
        typeof item.target === "string" ? item.target : item.target.id;
      const sourceIndex = positionsById.get(sourceId) ?? 0;
      const targetIndex = positionsById.get(targetId) ?? 0;
      edgeIndexData[index * 2] = sourceIndex;
      edgeIndexData[index * 2 + 1] = targetIndex;
      edgePulse[index * 2] = 0.34 + random() * 0.38;
      edgePulse[index * 2 + 1] = random() * Math.PI * 2;
      edgeProgress[index * 2] = 0;
      edgeProgress[index * 2 + 1] = 1;
      const layer = relationLayerForEdge(knowledgeEdges[index]);
      const layerCode = layer === "structural" ? 0 : layer === "explicit" ? 1 : layer === "inferred" ? 2 : 3;
      edgeLayers[index * 2] = layerCode;
      edgeLayers[index * 2 + 1] = layerCode;

      const sourceColor = new THREE.Color(
        NODE_COLORS[simNodes[sourceIndex].kind],
      ).lerp(new THREE.Color("#f2eee5"), 0.32);
      const targetColor = new THREE.Color(
        NODE_COLORS[simNodes[targetIndex].kind],
      ).lerp(new THREE.Color("#f2eee5"), 0.32);
      const relationColor = new THREE.Color(RELATION_STYLES[knowledgeEdges[index].type].color);
      sourceColor.lerp(relationColor, 0.58);
      targetColor.lerp(relationColor, 0.58);
      baseEdgeColors.set(
        [
          sourceColor.r,
          sourceColor.g,
          sourceColor.b,
          targetColor.r,
          targetColor.g,
          targetColor.b,
        ],
        index * 6,
      );
    });

    const edgeGeometry = new THREE.BufferGeometry();
    edgeGeometry.setAttribute(
      "position",
      new THREE.BufferAttribute(edgePositions, 3),
    );
    edgeGeometry.setAttribute(
      "color",
      new THREE.BufferAttribute(edgeColors, 3),
    );
    edgeGeometry.setAttribute(
      "segmentProgress",
      new THREE.BufferAttribute(edgeProgress, 1),
    );
    edgeGeometry.setAttribute(
      "relationLayer",
      new THREE.BufferAttribute(edgeLayers, 1),
    );
    const edgeMaterial = new THREE.ShaderMaterial({
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      vertexColors: true,
      uniforms: {
        uTime: { value: 0 },
        uMotion: { value: reducedMotion ? 0 : 1 },
      },
      vertexShader: `
        attribute float segmentProgress;
        attribute float relationLayer;
        varying vec3 vColor;
        varying float vProgress;
        varying float vLayer;

        void main() {
          vColor = color;
          vProgress = segmentProgress;
          vLayer = relationLayer;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec3 vColor;
        varying float vProgress;
        varying float vLayer;
        uniform float uTime;
        uniform float uMotion;

        void main() {
          float alpha = 0.5;
          if (vLayer < 0.5) {
            alpha = 0.24;
          } else if (vLayer < 1.5) {
            alpha = 0.76;
          } else if (vLayer < 2.5) {
            float flow = fract(vProgress * 9.0 - uTime * 0.22 * uMotion);
            if (flow > 0.66) discard;
            alpha = 0.62;
          } else {
            float dash = fract(vProgress * 6.0);
            if (dash > 0.46) discard;
            alpha = 0.25;
          }
          gl_FragColor = vec4(vColor, alpha);
        }
      `,
    });
    const edgeLines = new THREE.LineSegments(edgeGeometry, edgeMaterial);
    scene.add(edgeLines);

    const particleGlowTexture = createParticleGlowTexture();
    const dustCount = luminosityPreviewEnabled ? (compact ? 420 : 720) : 240;
    const dustPositions = new Float32Array(dustCount * 3);
    const dustColors = new Float32Array(dustCount * 3);
    const dustPalette = [0x91cfff, 0xb6a2ff, 0xf2f7ff, 0xffc987];
    for (let index = 0; index < dustCount; index += 1) {
      const radius = luminosityPreviewEnabled
        ? graphRadius * (0.42 + Math.pow(random(), 1.45) * 2.45)
        : graphRadius * (1.2 + random() * 3.2);
      const theta = random() * Math.PI * 2;
      const phi = Math.acos(2 * random() - 1);
      dustPositions[index * 3] = radius * Math.sin(phi) * Math.cos(theta);
      dustPositions[index * 3 + 1] =
        radius * Math.cos(phi) * (luminosityPreviewEnabled ? 0.74 : 1);
      dustPositions[index * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta);
      color.setHex(dustPalette[index % dustPalette.length]);
      dustColors.set([color.r, color.g, color.b], index * 3);
    }
    const dustGeometry = new THREE.BufferGeometry();
    dustGeometry.setAttribute(
      "position",
      new THREE.BufferAttribute(dustPositions, 3),
    );
    dustGeometry.setAttribute(
      "color",
      new THREE.BufferAttribute(dustColors, 3),
    );
    const dustMaterial = new THREE.PointsMaterial({
      color: 0xb9c7d8,
      size: 0.9,
      sizeAttenuation: !luminosityPreviewEnabled,
      vertexColors: luminosityPreviewEnabled,
      map: particleGlowTexture,
      alphaTest: 0.012,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const dust = new THREE.Points(dustGeometry, dustMaterial);
    scene.add(dust);

    const nebulaPalette = [0x65b5ff, 0x9f7aea, 0x79d5c0, 0xff6678, 0xf3b35b, 0xefe8d8];
    const nebulaClouds = (Object.keys(DOMAIN_COLORS) as Domain[]).map((domain, domainIndex) => {
      const cloudCount = reducedMotion ? 44 : 76;
      const cloudPositions = new Float32Array(cloudCount * 3);
      const cloudRandom = xorshift(5011 + domainIndex * 173);
      for (let index = 0; index < cloudCount; index += 1) {
        const radius = graphRadius * (0.12 + Math.pow(cloudRandom(), 1.8) * 0.42);
        const angle = cloudRandom() * Math.PI * 2;
        cloudPositions[index * 3] = Math.cos(angle) * radius;
        cloudPositions[index * 3 + 1] = Math.sin(angle) * radius * 0.62;
        cloudPositions[index * 3 + 2] = (cloudRandom() - 0.5) * graphRadius * 0.42;
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(cloudPositions, 3));
      const material = new THREE.PointsMaterial({
        color: nebulaPalette[domainIndex],
        size: 4.5,
        sizeAttenuation: !luminosityPreviewEnabled,
        map: particleGlowTexture,
        alphaTest: 0.012,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const points = new THREE.Points(geometry, material);
      points.visible = false;
      scene.add(points);
      return { domain, points, geometry, material };
    });

    const orbitGroup = new THREE.Group();
    orbitGroup.visible = false;
    const orbitMaterials: THREE.LineBasicMaterial[] = [];
    const orbitLines = [0, 1].map((ringIndex) => {
      const vertices: THREE.Vector3[] = [];
      for (let index = 0; index < 160; index += 1) {
        const angle = (index / 160) * Math.PI * 2;
        vertices.push(new THREE.Vector3(Math.cos(angle), Math.sin(angle) * 0.48, Math.sin(angle * 2) * 0.08));
      }
      const geometry = new THREE.BufferGeometry().setFromPoints(vertices);
      const material = new THREE.LineBasicMaterial({
        color: ringIndex === 0 ? 0x65b5ff : 0x9f7aea,
        transparent: true,
        opacity: ringIndex === 0 ? 0.28 : 0.18,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      orbitMaterials.push(material);
      const line = new THREE.LineLoop(geometry, material);
      orbitGroup.add(line);
      return line;
    });
    scene.add(orbitGroup);

    const orbitDepthLayer = document.createElement("div");
    orbitDepthLayer.className = "orbit-depth-layer";
    orbitDepthLayer.hidden = true;
    orbitDepthLayer.setAttribute("aria-hidden", "true");
    orbitDepthLayer.setAttribute("aria-label", "궤도 관계 깊이");
    if (luminosityPreviewEnabled) host.appendChild(orbitDepthLayer);
    const orbitDepthMarkers = orbitDepthDescriptors("SELECTED", 0, 0).map(
      (descriptor) => {
        const element = document.createElement("div");
        element.className = "orbit-depth-marker";
        element.dataset.depth = descriptor.key;
        element.setAttribute("role", "note");
        const rail = document.createElement("i");
        const copy = document.createElement("div");
        const title = document.createElement("strong");
        const detail = document.createElement("span");
        const count = document.createElement("b");
        title.textContent = descriptor.title;
        detail.textContent = descriptor.detail;
        count.textContent = String(descriptor.count).padStart(2, "0");
        copy.appendChild(title);
        copy.appendChild(detail);
        element.appendChild(rail);
        element.appendChild(copy);
        element.appendChild(count);
        orbitDepthLayer.appendChild(element);
        return {
          key: descriptor.key as OrbitDepthKey,
          element,
          title,
          detail,
          count,
          measuredWidth: 0,
          measuredHeight: 0,
        };
      },
    );

    const photonCount = luminosityPreviewEnabled
      ? Math.max(18, Math.min(72, Math.ceil(edgeCount * 0.35)))
      : Math.max(6, Math.min(32, Math.ceil(edgeCount * 0.07)));
    const photonPositions = new Float32Array(photonCount * 3);
    const photonColors = new Float32Array(photonCount * 3);
    const photonGeometry = new THREE.BufferGeometry();
    photonGeometry.setAttribute("position", new THREE.BufferAttribute(photonPositions, 3));
    photonGeometry.setAttribute("color", new THREE.BufferAttribute(photonColors, 3));
    const photonMaterial = new THREE.PointsMaterial({
      color: 0xeaf6ff,
      size: 2.8,
      sizeAttenuation: !luminosityPreviewEnabled,
      vertexColors: luminosityPreviewEnabled,
      map: particleGlowTexture,
      alphaTest: 0.012,
      transparent: true,
      opacity: reducedMotion ? 0 : 0.82,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const photonPoints = new THREE.Points(photonGeometry, photonMaterial);
    scene.add(photonPoints);

    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bloomPass = new UnrealBloomPass(
      new THREE.Vector2(host.clientWidth, Math.max(1, host.clientHeight)),
      1.08,
      0.68,
      0.055,
    );
    composer.addPass(bloomPass);

    const qualityProfiles: Record<RenderQuality, {
      pixelRatio: number;
      bloom: number;
      dust: number;
      photon: number;
      edgeStride: number;
    }> = {
      high: { pixelRatio: 2, bloom: 1, dust: 1, photon: 1, edgeStride: 1 },
      balanced: { pixelRatio: 1.5, bloom: 0.92, dust: 0.65, photon: 0.65, edgeStride: 1 },
      low: { pixelRatio: 1, bloom: 0.8, dust: 0.25, photon: 0, edgeStride: 2 },
    };
    let renderQuality: RenderQuality = compact ? "balanced" : "high";
    let activeLuminositySettings: LuminositySettings =
      resolveLuminositySettings("bright", {
        compact,
        previewV2: luminosityPreviewEnabled,
      });
    let activeFocusContrastSettings: FocusContrastSettings =
      resolveFocusContrast("medium");

    const syncVisualTuning = () => {
      const profile = qualityProfiles[renderQuality];
      const particleIntensity = luminosityPreviewEnabled
        ? activeLuminositySettings.particleIntensity
        : 1;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, profile.pixelRatio));
      nodeMaterial.uniforms.uLuminosity.value = activeLuminositySettings.light;
      nodeMaterial.uniforms.uOutputCeiling.value = activeLuminositySettings.outputCeiling;
      nodeMaterial.uniforms.uSafeOutput.value = luminosityPreviewEnabled ? 1 : 0;
      bloomPass.strength =
        activeLuminositySettings.bloom *
        (luminosityPreviewEnabled ? 1 : profile.bloom);
      const visibleDustRatio = particleIntensity * profile.dust;
      const visibleDustCount =
        visibleDustRatio <= 0.005
          ? 0
          : Math.min(
              dustCount,
              Math.round(dustCount * (0.14 + visibleDustRatio * 0.86)),
            );
      dustGeometry.setDrawRange(0, visibleDustCount);
      dustMaterial.opacity = luminosityPreviewEnabled
        ? THREE.MathUtils.lerp(0.12, 0.68, particleIntensity) * profile.dust
        : activeLuminositySettings.dust * profile.dust;
      dustMaterial.size = luminosityPreviewEnabled
        ? THREE.MathUtils.lerp(0.8, 2.25, particleIntensity)
        : 0.9;
      dust.visible = profile.dust > 0 && particleIntensity > 0.005;
      photonMaterial.opacity = luminosityPreviewEnabled
        ? activeLuminositySettings.photon *
          (reducedMotion ? Math.max(0.55, profile.photon) : profile.photon)
        : reducedMotion
          ? 0
          : activeLuminositySettings.photon * profile.photon;
      photonMaterial.size = luminosityPreviewEnabled
        ? THREE.MathUtils.lerp(1.1, 3.8, particleIntensity)
        : 2.8;
      if (luminosityPreviewEnabled) {
        photonGeometry.setDrawRange(0, 0);
        photonPoints.visible = false;
      } else {
        photonGeometry.setDrawRange(
          0,
          particleIntensity <= 0.005
            ? 0
            : Math.min(
                photonCount,
                Math.round(photonCount * (0.2 + particleIntensity * 0.8)),
              ),
        );
        photonPoints.visible =
          !reducedMotion && profile.photon > 0 && particleIntensity > 0.005;
      }

      nebulaClouds.forEach(({ points, material }) => {
        const visible = currentView === "nebula" && particleIntensity > 0.005;
        points.visible = visible;
        material.size = luminosityPreviewEnabled
          ? THREE.MathUtils.lerp(1.5, 5.2, particleIntensity)
          : 4.5;
        if (!visible) material.opacity = 0;
      });
    };

    const setRenderQuality = (next: RenderQuality) => {
      if (next === renderQuality) return;
      renderQuality = next;
      syncVisualTuning();
    };

    const labelLayer = document.createElement("div");
    labelLayer.className = "graph-label-layer";
    host.appendChild(labelLayer);
    const labels = simNodes
      .map((item, index) => {
        if (!luminosityPreviewEnabled && item.kind !== "thesis") return null;
        const element = document.createElement("button");
        element.type = "button";
        element.className = luminosityPreviewEnabled
          ? `graph-node-label${item.kind === "thesis" ? " is-thesis" : ""}`
          : "graph-thesis-label";
        element.textContent = item.shortLabel;
        element.setAttribute("aria-label", `지식 노드: ${item.label}`);
        element.dataset.nodeKind = item.kind;
        element.style.setProperty("--label-accent", DOMAIN_COLORS[item.domain]);
        element.tabIndex = -1;
        element.addEventListener("click", () => selectNode(item.id));
        if (luminosityPreviewEnabled) {
          element.addEventListener("pointerenter", (event) => {
            setHovered({ id: item.id, x: event.clientX, y: event.clientY });
          });
          element.addEventListener("pointermove", (event) => {
            setHovered({ id: item.id, x: event.clientX, y: event.clientY });
          });
          element.addEventListener("pointerleave", () => setHovered(null));
          element.addEventListener("focus", () => {
            const bounds = element.getBoundingClientRect();
            element.setAttribute("aria-describedby", "graph-node-tooltip");
            setHovered({
              id: item.id,
              x: bounds.left + Math.min(bounds.width, 24),
              y: bounds.bottom,
            });
          });
          element.addEventListener("blur", () => {
            element.removeAttribute("aria-describedby");
            setHovered(null);
          });
        }
        labelLayer.appendChild(element);
        return {
          element,
          index,
          id: item.id,
          kind: item.kind,
          degree: nodeDegrees[index],
          lodVisible: false,
          collisionVisible: false,
          keyboardRevealed: false,
          focusTier: "ambient" as LabelFocusTier,
          priority: 0,
          measuredWidth: 0,
          measuredHeight: 0,
        };
      })
      .filter(
        (
          item,
        ): item is {
          element: HTMLButtonElement;
          index: number;
          id: string;
          kind: NodeKind;
          degree: number;
          lodVisible: boolean;
          collisionVisible: boolean;
          keyboardRevealed: boolean;
          focusTier: LabelFocusTier;
          priority: number;
          measuredWidth: number;
          measuredHeight: number;
        } => item !== null,
      );
    let activeLabelLod: LabelLod = "overview";
    let activeLabelIds = new Set(
      labels.filter(({ kind }) => kind === "thesis").map(({ id }) => id),
    );
    let labelSelectionKey = "";
    let collisionVisibleIds = new Set<string>();

    const raycaster = new THREE.Raycaster();
    raycaster.params.Points!.threshold = graphRadius * 0.028;
    const pointer = new THREE.Vector2();
    let pointerDirty = false;
    let pointerDown: { x: number; y: number } | null = null;
    let hoveredId: string | null = null;
    let frame = 0;
    let lastTime = performance.now();
    let lastPulse = lastTime;
    let frameSerial = 0;
    let performanceWindowStartedAt = lastTime;
    let performanceWindowFrames = 0;
    let lowPerformanceWindows = 0;
    let highPerformanceWindows = 0;
    const frameDurations: number[] = [];

    const setPointer = (event: PointerEvent) => {
      const bounds = renderer.domElement.getBoundingClientRect();
      pointer.set(
        ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
        -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
      );
      pointerDirty = true;
    };

    const handlePointerMove = (event: PointerEvent) => {
      setPointer(event);
      if (hoveredId) {
        setHovered({ id: hoveredId, x: event.clientX, y: event.clientY });
      }
    };

    const handlePointerLeave = () => {
      hoveredId = null;
      setHovered(null);
      renderer.domElement.style.cursor = "grab";
    };

    const handlePointerDown = (event: PointerEvent) => {
      pointerDown = { x: event.clientX, y: event.clientY };
    };

    const handleClick = (event: MouseEvent) => {
      if (
        pointerDown &&
        Math.hypot(
          event.clientX - pointerDown.x,
          event.clientY - pointerDown.y,
        ) > 6
      )
        return;
      setPointer(event as unknown as PointerEvent);
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObject(nodePoints, false)[0];
      if (hit && hit.index !== undefined) {
        selectNode(simNodes[hit.index].id);
      } else {
        setSelectedId(null);
      }
    };

    renderer.domElement.addEventListener("pointermove", handlePointerMove);
    renderer.domElement.addEventListener("pointerleave", handlePointerLeave);
    renderer.domElement.addEventListener("pointerdown", handlePointerDown);
    renderer.domElement.addEventListener("click", handleClick);
    renderer.domElement.style.cursor = "grab";

    let currentView: GraphViewMode = "constellation";
    let layoutTransitionStartedAt = 0;
    let layoutTransitionDuration = 0;
    let currentOrbitRadii: [number, number] = [
      graphRadius * 0.72,
      graphRadius * 1.28,
    ];

    const setLayoutDecorations = (mode: GraphViewMode, result: LayoutResult) => {
      const particleIntensity = luminosityPreviewEnabled
        ? activeLuminositySettings.particleIntensity
        : 1;
      nebulaClouds.forEach(({ domain, points, material }) => {
        const center = result.clusterCenters.get(domain);
        points.visible =
          mode === "nebula" && Boolean(center) && particleIntensity > 0.005;
        material.opacity =
          mode === "nebula" ? 0.3 * particleIntensity : 0;
        if (center) points.position.set(center[0], center[1], center[2]);
      });
      orbitGroup.visible = mode === "orbit";
      const orbitDepthVisible = luminosityPreviewEnabled && mode === "orbit";
      orbitDepthLayer.hidden = !orbitDepthVisible;
      orbitDepthLayer.setAttribute("aria-hidden", String(!orbitDepthVisible));
      if (mode === "orbit" && result.orbitRadii) {
        currentOrbitRadii = result.orbitRadii;
        orbitLines[0].scale.setScalar(result.orbitRadii[0]);
        orbitLines[1].scale.setScalar(result.orbitRadii[1]);
      }
      if (orbitDepthVisible) {
        const centerLabel =
          simNodes.find((item) => item.id === result.centerId)?.shortLabel ??
          "SELECTED";
        const descriptors = orbitDepthDescriptors(
          centerLabel,
          result.oneHop.size,
          result.twoHop.size,
        );
        orbitDepthLayer.dataset.centerId = result.centerId ?? "";
        orbitDepthMarkers.forEach((marker, index) => {
          const descriptor = descriptors[index];
          marker.title.textContent = descriptor.title;
          marker.detail.textContent = descriptor.detail;
          marker.count.textContent = String(descriptor.count).padStart(2, "0");
          marker.element.setAttribute(
            "aria-label",
            descriptor.key === "core"
              ? `CORE, 선택 노드 ${descriptor.detail}`
              : `${descriptor.title}, ${descriptor.key === "depth-1" ? "직접" : "확장"} 관계 ${descriptor.count}개`,
          );
          marker.measuredWidth = 0;
          marker.measuredHeight = 0;
          marker.element.classList.remove("is-refreshing");
          void marker.element.offsetWidth;
          marker.element.classList.add("is-refreshing");
        });
      }
    };

    const cameraPositionFor = (mode: GraphViewMode) =>
      new THREE.Vector3(
        graphRadius * 0.08,
        graphRadius * 0.14,
        graphRadius * (mode === "constellation" ? 1.85 : mode === "nebula" ? 2.65 : 2.72),
      );

    const moveCameraHome = (mode: GraphViewMode, animated: boolean) => {
      const endCamera = cameraPositionFor(mode);
      const startCamera = camera.position.clone();
      const startTarget = controls.target.clone();
      const startedAt = performance.now();
      const duration = reducedMotion || !animated ? 0 : 780;
      const tick = () => {
        const progress = duration === 0 ? 1 : clamp((performance.now() - startedAt) / duration, 0, 1);
        const eased = 1 - Math.pow(1 - progress, 3);
        camera.position.lerpVectors(startCamera, endCamera, eased);
        controls.target.lerpVectors(startTarget, new THREE.Vector3(0, 0, 0), eased);
        if (progress < 1) requestAnimationFrame(tick);
      };
      tick();
    };

    const applyLayout = (
      mode: GraphViewMode,
      centerId?: string | null,
      animateTransition = true,
    ) => {
      const previousView = currentView;
      const result = calculateLayout(
        mode,
        simNodes,
        knowledgeEdges,
        constellationPositions,
        graphRadius,
        centerId,
      );
      layoutFromPositions.set(baseNodePositions);
      result.positions.forEach((position, index) => {
        layoutTargetPositions.set(position, index * 3);
      });
      currentView = mode;
      nodeMaterial.uniforms.uViewScale.value = mode === "nebula" ? 1.32 : mode === "orbit" ? 1.14 : 1;
      layoutTransitionStartedAt = performance.now();
      layoutTransitionDuration = reducedMotion || !animateTransition ? 0 : 780;
      if (layoutTransitionDuration === 0) baseNodePositions.set(layoutTargetPositions);
      setLayoutDecorations(mode, result);
      if (previousView !== mode || !animateTransition) moveCameraHome(mode, animateTransition);
    };

    const applyLuminosity = (preset: LuminosityPreset) => {
      activeLuminositySettings = resolveLuminositySettings(preset, {
        compact,
        previewV2: luminosityPreviewEnabled,
      });
      activeFocusContrastSettings = resolveFocusContrast("medium");
      syncVisualTuning();
    };

    const applyLuminosityControls = (controls: LuminosityControls) => {
      activeLuminositySettings = resolveLuminosityControls(controls);
      activeFocusContrastSettings = resolveFocusContrast(controls.focusContrast);
      syncVisualTuning();
    };

    const flyTo = (id: string) => {
      const index = positionsById.get(id);
      if (index === undefined) return;
      const target = new THREE.Vector3(
        baseNodePositions[index * 3],
        baseNodePositions[index * 3 + 1],
        baseNodePositions[index * 3 + 2],
      );
      const direction = camera.position
        .clone()
        .sub(controls.target)
        .normalize();
      const startCamera = camera.position.clone();
      const startTarget = controls.target.clone();
      const endCamera = target
        .clone()
        .add(direction.multiplyScalar(graphRadius * 0.78));
      const startedAt = performance.now();
      const duration = 860;

      const animateFlight = () => {
        const progress = clamp((performance.now() - startedAt) / duration, 0, 1);
        const eased = 1 - Math.pow(1 - progress, 3);
        camera.position.lerpVectors(startCamera, endCamera, eased);
        controls.target.lerpVectors(startTarget, target, eased);
        if (progress < 1) requestAnimationFrame(animateFlight);
      };
      animateFlight();
    };

    graphApiRef.current = {
      reset: () => {
        const startCamera = camera.position.clone();
        const startTarget = controls.target.clone();
        const resetCameraPosition = cameraPositionFor(currentView);
        const startedAt = performance.now();
        const duration = 780;
        const animateReset = () => {
          const progress = clamp(
            (performance.now() - startedAt) / duration,
            0,
            1,
          );
          const eased = 1 - Math.pow(1 - progress, 3);
          camera.position.lerpVectors(startCamera, resetCameraPosition, eased);
          controls.target.lerpVectors(
            startTarget,
            new THREE.Vector3(0, 0, 0),
            eased,
          );
          if (progress < 1) requestAnimationFrame(animateReset);
        };
        animateReset();
      },
      flyTo,
      setAutoRotate: (value, speed) => {
        controls.autoRotate = value;
        controls.autoRotateSpeed = speed;
      },
      setLabelsVisible: (value) => {
        labelLayer.style.display = value ? "" : "none";
      },
      setViewMode: (mode, centerId) => applyLayout(mode, centerId),
      setLuminosity: applyLuminosity,
      setLuminosityControls: applyLuminosityControls,
    };

    applyLayout(viewModeRef.current, selectedIdRef.current, false);
    if (luminosityPreviewEnabled) {
      applyLuminosityControls(luminosityControlsRef.current);
    } else {
      applyLuminosity(luminosityRef.current);
    }

    const projection = new THREE.Vector3();
    const orbitDepthWorldPosition = new THREE.Vector3();
    const orbitDepthAxis = new THREE.Vector3(0, 0, 1);

    const animate = (now: number) => {
      frame = requestAnimationFrame(animate);
      frameSerial += 1;
      const rawFrameDuration = Math.max(0, Math.min(250, now - lastTime));
      const delta = Math.min((now - lastTime) / 1000, 0.05);
      lastTime = now;
      const time = now / 1000;
      nodeMaterial.uniforms.uTime.value = time;

      if (layoutTransitionDuration > 0) {
        const progress = clamp(
          (now - layoutTransitionStartedAt) / layoutTransitionDuration,
          0,
          1,
        );
        const eased = 1 - Math.pow(1 - progress, 3);
        for (let index = 0; index < baseNodePositions.length; index += 1) {
          baseNodePositions[index] =
            layoutFromPositions[index] +
            (layoutTargetPositions[index] - layoutFromPositions[index]) * eased;
        }
        if (progress >= 1) layoutTransitionDuration = 0;
      }

      if (!reducedMotion) {
        for (let index = 0; index < nodeCount; index += 1) {
          const motionOffset = index * 7;
          const positionOffset = index * 3;
          const amplitude =
            nodeMotion[motionOffset + 6] *
            (currentView === "orbit" ? 0.24 : currentView === "nebula" ? 0.64 : 1);
          animatedNodePositions[positionOffset] =
            baseNodePositions[positionOffset] +
            amplitude *
              Math.sin(
                time * nodeMotion[motionOffset] +
                  nodeMotion[motionOffset + 1],
              );
          animatedNodePositions[positionOffset + 1] =
            baseNodePositions[positionOffset + 1] +
            amplitude *
              Math.sin(
                time * nodeMotion[motionOffset + 2] +
                  nodeMotion[motionOffset + 3],
              );
          animatedNodePositions[positionOffset + 2] =
            baseNodePositions[positionOffset + 2] +
            amplitude *
              Math.sin(
                time * nodeMotion[motionOffset + 4] +
                  nodeMotion[motionOffset + 5],
              );
        }
        nodeGeometry.attributes.position.needsUpdate = true;
      }

      if (!reducedMotion && now - lastPulse > 920) {
        lastPulse = now;
        const totalDegree = nodeDegrees.reduce((sum, value) => sum + value, 0);
        let selection = random() * totalDegree;
        for (let index = 0; index < nodeCount; index += 1) {
          selection -= nodeDegrees[index];
          if (selection <= 0) {
            nodeBoosts[index] = Math.max(nodeBoosts[index], 1.82);
            break;
          }
        }
      }

      const focus = focusRef.current;
      const selectedNodeId = selectedIdRef.current;
      edgeMaterial.uniforms.uTime.value = time;
      const ambientNodeBoost = luminosityPreviewEnabled
        ? activeLuminositySettings.ambientNodeBoost
        : 1;
      for (let index = 0; index < nodeCount; index += 1) {
        const nodeId = simNodes[index].id;
        let targetBoost = ambientNodeBoost;
        if (focus.nodeIds) {
          if (focus.expandedNodeIds?.has(nodeId)) {
            targetBoost =
              activeFocusContrastSettings.focusedNodeBoost *
              EXPANDED_FOCUS_VISIBILITY;
          } else if (focus.nodeIds.has(nodeId)) {
            targetBoost = activeFocusContrastSettings.focusedNodeBoost;
          } else {
            targetBoost = activeFocusContrastSettings.dimmedNodeBoost;
          }
        }
        if (
          luminosityPreviewEnabled &&
          selectedNodeId === nodeId
        ) {
          targetBoost = Math.min(2.2, targetBoost * 1.14);
        }
        if (!focus.nodeIds && nodeBoosts[index] > ambientNodeBoost) {
          nodeBoosts[index] =
            ambientNodeBoost +
            (nodeBoosts[index] - ambientNodeBoost) * Math.exp(-1.45 * delta);
        } else {
          nodeBoosts[index] +=
            (targetBoost - nodeBoosts[index]) * Math.min(1, 7 * delta);
        }
      }
      nodeGeometry.attributes.boost.needsUpdate = true;

      const selectedNodeIndex = selectedNodeId
        ? positionsById.get(selectedNodeId)
        : undefined;
      if (luminosityPreviewEnabled && selectedNodeIndex !== undefined) {
        const positionOffset = selectedNodeIndex * 3;
        beaconRing.position.fromArray(animatedNodePositions, positionOffset);
        beaconCorona.position.copy(beaconRing.position);

        beaconNodeColor.setHex(NODE_COLORS[simNodes[selectedNodeIndex].kind]);
        beaconRingMaterial.color.copy(beaconNodeColor).lerp(beaconWhite, 0.48);
        beaconCoronaMaterial.color.copy(beaconNodeColor).lerp(beaconCoolWhite, 0.34);

        const cameraDistance = Math.max(
          1,
          camera.position.distanceTo(beaconRing.position),
        );
        const worldPerPixel =
          (2 * cameraDistance * Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5))) /
          Math.max(1, host.clientHeight);
        const basePixels = 36 + nodeSizes[selectedNodeIndex] * 1.45;
        const breath = reducedMotion ? 0 : (Math.sin(time * 1.18) + 1) * 0.5;
        const ringPixels = basePixels * (1 + breath * 0.1);
        beaconRing.scale.setScalar(ringPixels * worldPerPixel);
        beaconCorona.scale.setScalar(basePixels * 1.42 * worldPerPixel);
        beaconRingMaterial.opacity = reducedMotion ? 0.64 : 0.48 + breath * 0.2;
        beaconCoronaMaterial.opacity = Math.min(
          0.34,
          0.16 + activeLuminositySettings.light * 0.09,
        );
        beaconRing.visible = true;
        beaconCorona.visible = true;
      } else {
        beaconRing.visible = false;
        beaconCorona.visible = false;
      }

      const updateEdges =
        qualityProfiles[renderQuality].edgeStride === 1 ||
        frameSerial % qualityProfiles[renderQuality].edgeStride === 0 ||
        layoutTransitionDuration > 0;
      if (updateEdges) {
        const focusedEdgeIntensity = luminosityPreviewEnabled
          ? activeLuminositySettings.edgeIntensity
          : 1;
        for (let index = 0; index < edgeCount; index += 1) {
          const sourceIndex = edgeIndexData[index * 2];
          const targetIndex = edgeIndexData[index * 2 + 1];
          const sourceOffset = sourceIndex * 3;
          const targetOffset = targetIndex * 3;
          edgePositions.set(
            [
              animatedNodePositions[sourceOffset],
              animatedNodePositions[sourceOffset + 1],
              animatedNodePositions[sourceOffset + 2],
              animatedNodePositions[targetOffset],
              animatedNodePositions[targetOffset + 1],
              animatedNodePositions[targetOffset + 2],
            ],
            index * 6,
          );

          const id = edgeId(knowledgeEdges[index]);
          let brightness = focus.edgeIds
            ? focus.directEdgeIds?.has(id)
              ? focusedEdgeIntensity
              : focus.expandedEdgeIds?.has(id)
                ? focusedEdgeIntensity * EXPANDED_FOCUS_VISIBILITY
                : activeFocusContrastSettings.dimmedEdgeBrightness *
                  focusedEdgeIntensity
            : activeLuminositySettings.ambientEdgeBrightness;
          if (focus.edgeIds) {
            const relationLayer = relationLayerForEdge(knowledgeEdges[index]);
            brightness *= relationLayer === "structural"
              ? focus.directEdgeIds?.has(id) ? 0.78 : 0.58
              : relationLayer === "display"
                ? 0.5
                : focus.directEdgeIds?.has(id) ? 1.18 : 1.04;
          }
          if (!focus.edgeIds && !reducedMotion) {
            brightness *=
              1 +
              0.24 *
                Math.sin(time * edgePulse[index * 2] + edgePulse[index * 2 + 1]);
          }
          for (let channel = 0; channel < 6; channel += 1) {
            edgeColors[index * 6 + channel] =
              baseEdgeColors[index * 6 + channel] * brightness;
          }
        }
        edgeGeometry.attributes.position.needsUpdate = true;
        edgeGeometry.attributes.color.needsUpdate = true;
      }

      if (luminosityPreviewEnabled) {
        const particleIntensity = activeLuminositySettings.particleIntensity;
        const photonQuality = reducedMotion
          ? Math.max(0.55, qualityProfiles[renderQuality].photon)
          : qualityProfiles[renderQuality].photon;
        const selectedPathEdges: Array<{ index: number; expanded: boolean }> = [];
        if (selectedNodeId && focus.edgeIds) {
          for (let index = 0; index < edgeCount; index += 1) {
            const id = edgeId(knowledgeEdges[index]);
            if (focus.directEdgeIds?.has(id)) {
              selectedPathEdges.push({ index, expanded: false });
            }
          }
          for (let index = 0; index < edgeCount; index += 1) {
            const id = edgeId(knowledgeEdges[index]);
            if (focus.expandedEdgeIds?.has(id)) {
              selectedPathEdges.push({ index, expanded: true });
            }
          }
          selectedPathEdges.sort((left, right) => {
            if (left.expanded !== right.expanded) return left.expanded ? 1 : -1;
            const priority = (edgeIndex: number) => {
              const layer = relationLayerForEdge(knowledgeEdges[edgeIndex]);
              return layer === "inferred" ? 0 : layer === "explicit" ? 1 : layer === "structural" ? 2 : 3;
            };
            return priority(left.index) - priority(right.index) || left.index - right.index;
          });
        }

        const pointsPerPacket = reducedMotion ? 1 : 3;
        const intensityCapacity =
          particleIntensity <= 0.005 || photonQuality <= 0.005
            ? 0
            : Math.max(
                pointsPerPacket,
                Math.round(
                  photonCount *
                    (0.22 + particleIntensity * 0.78) *
                    photonQuality,
                ),
              );
        const visiblePhotonCount = Math.min(
          photonCount,
          selectedPathEdges.length * pointsPerPacket,
          intensityCapacity,
        );

        for (let index = 0; index < visiblePhotonCount; index += 1) {
          const packetIndex = Math.floor(index / pointsPerPacket);
          const trailIndex = index % pointsPerPacket;
          const candidate = selectedPathEdges[packetIndex % selectedPathEdges.length];
          const edgeIndex = candidate.index;
          const sourceIndex = edgeIndexData[edgeIndex * 2];
          const targetIndex = edgeIndexData[edgeIndex * 2 + 1];
          const sourceOffset = sourceIndex * 3;
          const targetOffset = targetIndex * 3;
          const packetPhase =
            (packetIndex + 0.5) / Math.max(1, selectedPathEdges.length);
          const headProgress = reducedMotion
            ? 0.5
            : (time * (candidate.expanded ? 0.095 : 0.13) + packetPhase) % 1;
          const progress = reducedMotion
            ? headProgress
            : (headProgress - trailIndex * 0.038 + 1) % 1;

          photonPositions[index * 3] = THREE.MathUtils.lerp(
            animatedNodePositions[sourceOffset],
            animatedNodePositions[targetOffset],
            progress,
          );
          photonPositions[index * 3 + 1] = THREE.MathUtils.lerp(
            animatedNodePositions[sourceOffset + 1],
            animatedNodePositions[targetOffset + 1],
            progress,
          );
          photonPositions[index * 3 + 2] = THREE.MathUtils.lerp(
            animatedNodePositions[sourceOffset + 2],
            animatedNodePositions[targetOffset + 2],
            progress,
          );

          const trailGain = reducedMotion ? 0.72 : [1, 0.52, 0.24][trailIndex];
          const tierGain = candidate.expanded
            ? EXPANDED_FOCUS_VISIBILITY
            : 1;
          const gain = trailGain * tierGain;
          photonColors[index * 3] =
            THREE.MathUtils.lerp(
              baseEdgeColors[edgeIndex * 6],
              baseEdgeColors[edgeIndex * 6 + 3],
              progress,
            ) * gain;
          photonColors[index * 3 + 1] =
            THREE.MathUtils.lerp(
              baseEdgeColors[edgeIndex * 6 + 1],
              baseEdgeColors[edgeIndex * 6 + 4],
              progress,
            ) * gain;
          photonColors[index * 3 + 2] =
            THREE.MathUtils.lerp(
              baseEdgeColors[edgeIndex * 6 + 2],
              baseEdgeColors[edgeIndex * 6 + 5],
              progress,
            ) * gain;
        }

        photonGeometry.setDrawRange(0, visiblePhotonCount);
        photonPoints.visible = visiblePhotonCount > 0;
        if (visiblePhotonCount > 0) {
          photonGeometry.attributes.position.needsUpdate = true;
          photonGeometry.attributes.color.needsUpdate = true;
        }
      } else if (!reducedMotion && edgeCount > 0 && renderQuality !== "low") {
        const activeEdgeIndexes: number[] = [];
        for (let index = 0; index < edgeCount; index += 1) {
          if (!focus.edgeIds || focus.edgeIds.has(edgeId(knowledgeEdges[index]))) {
            activeEdgeIndexes.push(index);
          }
        }
        const candidates = activeEdgeIndexes.length ? activeEdgeIndexes : [0];
        for (let index = 0; index < photonCount; index += 1) {
          const edgeIndex = candidates[index % candidates.length];
          const sourceIndex = edgeIndexData[edgeIndex * 2];
          const targetIndex = edgeIndexData[edgeIndex * 2 + 1];
          const progress =
            (time * (0.1 + (index % 5) * 0.013) + index / photonCount) % 1;
          const sourceOffset = sourceIndex * 3;
          const targetOffset = targetIndex * 3;
          photonPositions[index * 3] = THREE.MathUtils.lerp(
            animatedNodePositions[sourceOffset],
            animatedNodePositions[targetOffset],
            progress,
          );
          photonPositions[index * 3 + 1] = THREE.MathUtils.lerp(
            animatedNodePositions[sourceOffset + 1],
            animatedNodePositions[targetOffset + 1],
            progress,
          );
          photonPositions[index * 3 + 2] = THREE.MathUtils.lerp(
            animatedNodePositions[sourceOffset + 2],
            animatedNodePositions[targetOffset + 2],
            progress,
          );
        }
        photonGeometry.attributes.position.needsUpdate = true;
      }

      if (currentView === "nebula" && !reducedMotion) {
        const dustFactor = qualityProfiles[renderQuality].dust;
        const particleIntensity = luminosityPreviewEnabled
          ? activeLuminositySettings.particleIntensity
          : 1;
        nebulaClouds.forEach(({ material }, index) => {
          material.opacity =
            (0.28 + Math.sin(time * 0.22 + index) * 0.035) *
            dustFactor *
            particleIntensity;
        });
      }
      if (currentView === "orbit" && !reducedMotion) {
        orbitGroup.rotation.z = Math.sin(time * 0.08) * 0.012;
      }

      const orbitDepthBlockers: ScreenLabelCandidate[] = [];
      if (
        luminosityPreviewEnabled &&
        currentView === "orbit" &&
        !orbitDepthLayer.hidden
      ) {
        const orbitCenterIndex = orbitDepthLayer.dataset.centerId
          ? positionsById.get(orbitDepthLayer.dataset.centerId)
          : undefined;
        orbitDepthMarkers.forEach((marker, index) => {
          if (marker.key === "core" && orbitCenterIndex !== undefined) {
            orbitDepthWorldPosition.fromArray(
              animatedNodePositions,
              orbitCenterIndex * 3,
            );
          } else {
            orbitDepthWorldPosition
              .fromArray(orbitDepthAnchor(marker.key, currentOrbitRadii))
              .applyAxisAngle(orbitDepthAxis, orbitGroup.rotation.z);
          }
          orbitDepthWorldPosition.project(camera);
          if (
            orbitDepthWorldPosition.z > 1 ||
            orbitDepthWorldPosition.z < -1
          ) {
            marker.element.style.display = "none";
            return;
          }
          marker.element.style.display = "";
          if (marker.measuredWidth <= 0 || marker.measuredHeight <= 0) {
            marker.measuredWidth = marker.element.offsetWidth;
            marker.measuredHeight = marker.element.offsetHeight;
          }
          const anchorX =
            (orbitDepthWorldPosition.x * 0.5 + 0.5) * host.clientWidth;
          const anchorY =
            (-orbitDepthWorldPosition.y * 0.5 + 0.5) * host.clientHeight;
          let x =
            marker.key === "core"
              ? anchorX - marker.measuredWidth * 0.5
              : anchorX + 13;
          let y =
            marker.key === "core"
              ? anchorY - marker.measuredHeight - 46
              : anchorY - marker.measuredHeight * 0.5;
          x = clamp(x, 8, host.clientWidth - marker.measuredWidth - 8);
          y = clamp(y, 82, host.clientHeight - marker.measuredHeight - 80);
          const markerGap = 10;
          const overlapsDepthMarker = (candidateX: number, candidateY: number) =>
            orbitDepthBlockers.some(
              (blocker) =>
                candidateX < blocker.x + blocker.width + markerGap &&
                candidateX + marker.measuredWidth + markerGap > blocker.x &&
                candidateY < blocker.y + blocker.height + markerGap &&
                candidateY + marker.measuredHeight + markerGap > blocker.y,
            );
          if (overlapsDepthMarker(x, y)) {
            const horizontalCandidates = orbitDepthBlockers.flatMap((blocker) => [
              [blocker.x + blocker.width + markerGap, y],
              [blocker.x - marker.measuredWidth - markerGap, y],
            ]);
            const verticalCandidates = orbitDepthBlockers.flatMap((blocker) => [
              [x, blocker.y + blocker.height + markerGap],
              [x, blocker.y - marker.measuredHeight - markerGap],
            ]);
            const alternate = [...horizontalCandidates, ...verticalCandidates]
              .map(([candidateX, candidateY]) => [
                clamp(
                  candidateX,
                  8,
                  host.clientWidth - marker.measuredWidth - 8,
                ),
                clamp(
                  candidateY,
                  82,
                  host.clientHeight - marker.measuredHeight - 80,
                ),
              ])
              .find(
                ([candidateX, candidateY]) =>
                  !overlapsDepthMarker(candidateX, candidateY),
              );
            if (alternate) [x, y] = alternate;
          }
          marker.element.style.transform = `translate3d(${x}px, ${y}px, 0)`;
          orbitDepthBlockers.push({
            id: `__orbit-${marker.key}`,
            x,
            y,
            width: marker.measuredWidth,
            height: marker.measuredHeight,
            priority: 12_000 - index * 500,
            previouslyVisible: true,
          });
        });
      }

      if (pointerDirty) {
        pointerDirty = false;
        raycaster.setFromCamera(pointer, camera);
        const hit = raycaster.intersectObject(nodePoints, false)[0];
        const nextId =
          hit && hit.index !== undefined ? simNodes[hit.index].id : null;
        if (nextId !== hoveredId) {
          hoveredId = nextId;
          if (!nextId) setHovered(null);
          renderer.domElement.style.cursor = nextId ? "pointer" : "grab";
        }
      }

      if (luminosityPreviewEnabled) {
        const nextLabelLod = resolveLabelLod(
          camera.position.distanceTo(controls.target),
          graphRadius,
        );
        const nextLabelSelectionKey = [
          nextLabelLod,
          selectedNodeId ?? "",
          focus.directNodeIds ? [...focus.directNodeIds].sort().join(",") : "",
          focus.expandedNodeIds ? [...focus.expandedNodeIds].sort().join(",") : "",
          focus.nodeIds && !selectedNodeId ? [...focus.nodeIds].sort().join(",") : "",
        ].join("|");

        if (nextLabelSelectionKey !== labelSelectionKey) {
          labelSelectionKey = nextLabelSelectionKey;
          activeLabelLod = nextLabelLod;
          labelLayer.dataset.lod = activeLabelLod;
          const labelCandidates = labels.map(({ id, kind, degree }) => {
            let focusTier: LabelFocusTier = "ambient";
            if (id === selectedNodeId) focusTier = "selected";
            else if (focus.directNodeIds?.has(id)) focusTier = "direct";
            else if (focus.expandedNodeIds?.has(id)) focusTier = "expanded";
            else if (focus.nodeIds?.has(id)) focusTier = "direct";
            return { id, kind, degree, focusTier };
          });
          activeLabelIds = selectLabelIds(
            labelCandidates,
            activeLabelLod,
            compact,
            Boolean(selectedNodeId),
          );
          const candidatesById = new Map(
            labelCandidates.map((candidate) => [candidate.id, candidate]),
          );
          labels.forEach((label) => {
            const candidate = candidatesById.get(label.id);
            label.priority = candidate ? scoreLabelCandidate(candidate) : 0;
            label.measuredWidth = 0;
            label.measuredHeight = 0;
          });
        }
      }

      const projectedLabelCandidates: ScreenLabelCandidate[] = [];
      labels.forEach((label) => {
        const { element, index, id } = label;
        let focusTier: LabelFocusTier = "ambient";
        if (id === selectedNodeId) focusTier = "selected";
        else if (focus.directNodeIds?.has(id)) focusTier = "direct";
        else if (focus.expandedNodeIds?.has(id)) focusTier = "expanded";
        else if (focus.nodeIds?.has(id)) focusTier = "direct";
        if (label.focusTier !== focusTier) {
          label.focusTier = focusTier;
          element.dataset.focusTier = focusTier;
        }

        const lodVisible = activeLabelIds.has(id);
        if (label.lodVisible !== lodVisible) {
          label.lodVisible = lodVisible;
          element.setAttribute("aria-hidden", String(!lodVisible));
          element.tabIndex = lodVisible ? 0 : -1;
        }
        if (!lodVisible) {
          element.style.display = "none";
          return;
        }

        projection
          .set(
            animatedNodePositions[index * 3],
            animatedNodePositions[index * 3 + 1],
            animatedNodePositions[index * 3 + 2],
          )
          .project(camera);
        if (projection.z > 1 || projection.z < -1) {
          element.style.display = "none";
          return;
        }
        element.style.display = "";
        const anchorX = (projection.x * 0.5 + 0.5) * host.clientWidth;
        const anchorY = (-projection.y * 0.5 + 0.5) * host.clientHeight;
        let x = anchorX + 13;
        let y = anchorY - 8;
        element.style.transform = `translate3d(${x}px, ${y}px, 0)`;
        if (!luminosityPreviewEnabled) {
          element.setAttribute("aria-hidden", "false");
          element.tabIndex = 0;
          element.style.pointerEvents = "auto";
          element.style.opacity = String(
            focus.nodeIds ? (focus.nodeIds.has(id) ? 0.96 : 0.12) : 0.88,
          );
          return;
        }

        if (label.measuredWidth <= 0 || label.measuredHeight <= 0) {
          label.measuredWidth = element.offsetWidth;
          label.measuredHeight = element.offsetHeight;
        }
        if (x + label.measuredWidth > host.clientWidth - 8) {
          x = anchorX - label.measuredWidth - 13;
        }
        if (y + label.measuredHeight > host.clientHeight - 68) {
          y = anchorY - label.measuredHeight - 12;
        } else if (y < 8) {
          y = anchorY + 12;
        }
        element.style.transform = `translate3d(${x}px, ${y}px, 0)`;
        projectedLabelCandidates.push({
          id,
          x,
          y,
          width: label.measuredWidth,
          height: label.measuredHeight,
          priority: label.priority,
          previouslyVisible: collisionVisibleIds.has(id),
        });
      });

      if (luminosityPreviewEnabled) {
        collisionVisibleIds = resolveLabelCollisions(
          [...orbitDepthBlockers, ...projectedLabelCandidates],
          { width: host.clientWidth, height: host.clientHeight - 62, inset: 6 },
          compact ? 4 : 6,
        );
        labelLayer.dataset.visibleCount = String(
          labels.filter((label) => collisionVisibleIds.has(label.id)).length,
        );
        labelLayer.dataset.candidateCount = String(projectedLabelCandidates.length);

        labels.forEach((label) => {
          const { element } = label;
          const collisionVisible =
            label.lodVisible && collisionVisibleIds.has(label.id);
          if (
            label.collisionVisible !== collisionVisible ||
            !element.dataset.collision
          ) {
            label.collisionVisible = collisionVisible;
            element.dataset.collision = collisionVisible ? "visible" : "hidden";
          }
          if (!label.lodVisible) return;
          const keyboardRevealed = document.activeElement === element;
          if (label.keyboardRevealed !== keyboardRevealed) {
            label.keyboardRevealed = keyboardRevealed;
            element.dataset.keyboardReveal = String(keyboardRevealed);
          }
          element.style.pointerEvents =
            collisionVisible || keyboardRevealed ? "auto" : "none";
          element.style.opacity = String(
            !collisionVisible && !keyboardRevealed
              ? 0
              : !focus.nodeIds
                ? label.kind === "thesis"
                  ? 0.9
                  : activeLabelLod === "detail"
                    ? 0.76
                    : 0.66
                : label.focusTier === "selected"
                  ? 1
                  : label.focusTier === "direct"
                    ? 0.92
                    : label.focusTier === "expanded"
                      ? 0.68
                      : 0.22,
          );
        });
      }

      controls.update();
      composer.render();

      performanceWindowFrames += 1;
      if (rawFrameDuration > 0) frameDurations.push(rawFrameDuration);
      const performanceElapsed = now - performanceWindowStartedAt;
      if (performanceElapsed >= 2_000) {
        const fps = (performanceWindowFrames * 1_000) / performanceElapsed;
        const sortedDurations = [...frameDurations].sort((a, b) => a - b);
        const p95FrameMs =
          sortedDurations[Math.min(sortedDurations.length - 1, Math.floor(sortedDurations.length * 0.95))] ?? 0;
        const targetFps = compact ? 30 : 45;

        if (fps < targetFps - 5) {
          lowPerformanceWindows += 1;
          highPerformanceWindows = 0;
        } else if (fps > targetFps + 8) {
          highPerformanceWindows += 1;
          lowPerformanceWindows = 0;
        } else {
          lowPerformanceWindows = 0;
          highPerformanceWindows = 0;
        }

        if (lowPerformanceWindows >= 2) {
          setRenderQuality(renderQuality === "high" ? "balanced" : "low");
          lowPerformanceWindows = 0;
        } else if (highPerformanceWindows >= 3) {
          if (renderQuality === "low") setRenderQuality("balanced");
          else if (renderQuality === "balanced" && !compact) setRenderQuality("high");
          highPerformanceWindows = 0;
        }

        if (performanceEnabled) {
          const memory = (
            performance as Performance & {
              memory?: { usedJSHeapSize?: number };
            }
          ).memory;
          setPerformanceMetrics({
            fps: Math.round(fps * 10) / 10,
            p95FrameMs: Math.round(p95FrameMs * 10) / 10,
            quality: renderQuality,
            drawCalls: renderer.info.render.calls,
            geometries: renderer.info.memory.geometries,
            heapMb: memory?.usedJSHeapSize
              ? Math.round((memory.usedJSHeapSize / 1024 / 1024) * 10) / 10
              : undefined,
          });
        }

        performanceWindowStartedAt = now;
        performanceWindowFrames = 0;
        frameDurations.length = 0;
      }
    };

    frame = requestAnimationFrame(animate);

    const resizeObserver = new ResizeObserver(() => {
      const width = host.clientWidth;
      const height = Math.max(1, host.clientHeight);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
      composer.setSize(width, height);
    });
    resizeObserver.observe(host);

    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener("pointermove", handlePointerMove);
      renderer.domElement.removeEventListener("pointerleave", handlePointerLeave);
      renderer.domElement.removeEventListener("pointerdown", handlePointerDown);
      renderer.domElement.removeEventListener("click", handleClick);
      labels.forEach(({ element }) => element.remove());
      labelLayer.remove();
      orbitDepthLayer.remove();
      controls.dispose();
      composer.dispose();
      nodeGeometry.dispose();
      nodeMaterial.dispose();
      scene.remove(beaconCorona, beaconRing);
      beaconCoronaTexture.dispose();
      beaconRingTexture.dispose();
      beaconCoronaMaterial.dispose();
      beaconRingMaterial.dispose();
      edgeGeometry.dispose();
      edgeMaterial.dispose();
      dustGeometry.dispose();
      dustMaterial.dispose();
      nebulaClouds.forEach(({ points, geometry, material }) => {
        scene.remove(points);
        geometry.dispose();
        material.dispose();
      });
      orbitLines.forEach((line) => line.geometry.dispose());
      orbitMaterials.forEach((material) => material.dispose());
      photonGeometry.dispose();
      photonMaterial.dispose();
      particleGlowTexture.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      graphApiRef.current = null;
    };
  }, [knowledgeEdges, knowledgeNodes, performanceEnabled, selectNode]);

  const clearFocus = () => {
    setSelectedId(null);
    setActiveLens("all");
    clearDomains();
    clearKinds();
    clearRelations();
    clearLayers();
  };

  const selectLuminosityPreset = (preset: LuminosityPreset) => {
    setLuminosity(preset);
    setLuminosityControls({ ...luminosityPresetControls[preset] });
    setLuminosityCustom(false);
  };

  const openOrRestoreCustomLuminosity = () => {
    if (savedCustomControls && !luminosityCustom) {
      setLuminosityControls({ ...savedCustomControls });
      setLuminosityCustom(true);
      setLuminosityPanelOpen(true);
      return;
    }
    setLuminosityPanelOpen((value) => !value);
  };

  const updateLuminosityControl = (
    key: "overall" | "edges" | "bloom" | "particles",
    value: number,
  ) => {
    const nextControls = { ...luminosityControls, [key]: value };
    setLuminosityControls(nextControls);
    setSavedCustomControls(nextControls);
    setLuminosityCustom(true);
  };

  const updateFocusContrast = (focusContrast: FocusContrast) => {
    const nextControls = { ...luminosityControls, focusContrast };
    setLuminosityControls(nextControls);
    setSavedCustomControls(nextControls);
    setLuminosityCustom(true);
  };

  const resetLuminosityControls = () => {
    setLuminosityControls({ ...luminosityPresetControls[luminosity] });
    setSavedCustomControls(null);
    setLuminosityCustom(false);
  };

  const hoveredNode = hovered ? nodeMap.get(hovered.id) : null;
  const hasFocus =
    selectedId ||
    activeDomains.size > 0 ||
    activeKinds.size > 0 ||
    activeRelations.size > 0 ||
    activeLayers.size > 0;

  return (
    <main
      className={`atlas-shell ${luminosityPreviewEnabled ? "is-luminosity-v2" : ""}`}
    >
      <aside
        className={`atlas-sidebar ${sidebarOpen ? "is-open" : ""}`}
        aria-label="지식 그래프 필터"
      >
        <div className="sidebar-scroll">
          <header className="atlas-brand">
            <div className="brand-mark" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
            <div>
              <p className="eyebrow">
                KNOWLEDGE GRAPH · {documentScopeContext
                  ? "DOCUMENT EVIDENCE"
                  : repositoryScopeContext
                  ? "REPOSITORY DETAIL"
                  : corpusScopeActive
                    ? publicStaticMode ? "PUBLIC STATIC CORPUS" : "FULL D1 CORPUS"
                  : overviewScopeActive
                    ? "REPOSITORY MAP"
                    : goldGraphActive
                    ? "ONTOLOGY GOLD SAMPLE"
                    : graphData.meta.source === "documents" ? "DOCUMENTS LIVE" : "DEMO 01"}
              </p>
              <h1>AI Systems Atlas</h1>
            </div>
            <button
              className="mobile-close"
              type="button"
              onClick={() => setSidebarOpen(false)}
              aria-label="필터 닫기"
            >
              ×
            </button>
          </header>

          <div className="graph-stats" aria-label="그래프 통계">
            <span>
              <strong>{knowledgeNodes.length}</strong> 노드
            </span>
            <span className="stats-divider" />
            <span>
              <strong>{knowledgeEdges.length}</strong> 관계
            </span>
            <span className="live-indicator">
              <i /> {graphLoading
                ? "SYNC"
                : graphError
                  ? "ERROR"
                  : repositoryScopeActive
                  ? "REPO"
                  : documentScopeActive
                    ? "DOC"
                  : corpusScopeActive
                    ? publicStaticMode ? "PUBLIC MAP" : "D1 MAP"
                  : overviewScopeActive
                    ? "MAP"
                    : goldGraphActive
                      ? "GOLD SAMPLE"
                    : graphData.meta.source === "documents" ? "DOCS" : "DEMO"}
            </span>
          </div>
          {graphData.meta.corpusNodeCount !== undefined && graphData.meta.corpusEdgeCount !== undefined && (
            <div className="corpus-stats" aria-label={publicStaticMode ? "공개 snapshot 전체 데이터 통계" : "D1 전체 데이터 통계"}>
              <span>{publicStaticMode ? "공개 원본" : "D1 전체"}</span>
              <strong>{graphData.meta.corpusNodeCount.toLocaleString()} 노드</strong>
              <i aria-hidden="true" />
              <strong>{graphData.meta.corpusEdgeCount.toLocaleString()} 관계</strong>
              <small>화면 {knowledgeNodes.length.toLocaleString()} / {knowledgeEdges.length.toLocaleString()}</small>
            </div>
          )}
          {graphData.meta.analytics && (
            <div className="graph-quality-strip" aria-label="그래프 품질 지표">
              <span>C {graphData.meta.analytics.communityCount}</span>
              <span>비구조 {Math.round(graphData.meta.analytics.nonStructuralRatio * 100)}%</span>
              <span>말단 {Math.round(graphData.meta.analytics.leafRatio * 100)}%</span>
            </div>
          )}

          <section className="filter-section">
            <div className="section-heading">
              <span>관점 렌즈</span>
              {hasFocus && (
                <button type="button" onClick={clearFocus}>
                  초기화
                </button>
              )}
            </div>
            <div className="lens-grid">
              {[
                ["all", "전체 우주", `${knowledgeNodes.length}개의 AI 개념`],
                ["agents", "에이전트", "실행과 협업"],
                ["memory", "지능의 기억", "검색과 관계"],
                ["safety", "신뢰와 안전", "평가와 위험"],
                ["product", "AI 제품", "운영과 피드백"],
              ].map(([id, title, description]) => (
                <button
                  key={id}
                  type="button"
                  className={activeLens === id ? "is-active" : ""}
                  aria-pressed={activeLens === id}
                  onClick={() => applyLens(id)}
                >
                  <span>{title}</span>
                  <small>{description}</small>
                </button>
              ))}
            </div>
          </section>

          <section className="filter-section">
            <div className="section-heading">
              <span>지식 분야</span>
              <span>{activeDomains.size || "ALL"}</span>
            </div>
            <div className="filter-list">
              {(Object.keys(domainLabels) as Domain[]).map((domain) => (
                <button
                  key={domain}
                  type="button"
                  className={activeDomains.has(domain) ? "is-active" : ""}
                  aria-pressed={activeDomains.has(domain)}
                  onClick={() => {
                    setActiveLens("custom");
                    toggleDomain(domain);
                  }}
                >
                  <i style={{ background: DOMAIN_COLORS[domain] }} />
                  <span>{domainLabels[domain]}</span>
                  <small>{domainCounts.get(domain)}</small>
                </button>
              ))}
            </div>
          </section>

          <section className="filter-section">
            <div className="section-heading">
              <span>노드 유형</span>
              <span>{activeKinds.size || "ALL"}</span>
            </div>
            <div className="type-pills">
              {(Object.keys(nodeKindLabels) as NodeKind[]).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  className={activeKinds.has(kind) ? "is-active" : ""}
                  aria-pressed={activeKinds.has(kind)}
                  onClick={() => toggleKind(kind)}
                >
                  {nodeKindLabels[kind]} <small>{kindCounts.get(kind)}</small>
                </button>
              ))}
            </div>
          </section>

          <section className="filter-section relation-section">
            <div className="section-heading">
              <span>관계 계층</span>
              <span>{activeLayers.size || "ALL"}</span>
            </div>
            <div className="relation-layer-pills">
              {(Object.keys(RELATION_LAYER_LABELS) as RelationLayer[]).map((layer) => (
                <button
                  key={layer}
                  type="button"
                  className={activeLayers.has(layer) ? "is-active" : ""}
                  aria-pressed={activeLayers.has(layer)}
                  onClick={() => toggleLayer(layer)}
                  style={{ "--layer-color": RELATION_LAYER_STYLES[layer].color } as React.CSSProperties}
                >
                  <i style={{ borderTopStyle: RELATION_LAYER_STYLES[layer].dash === "solid" ? "solid" : "dashed" }} />
                  {RELATION_LAYER_LABELS[layer]}
                  <small>{relationLayerCounts.get(layer) ?? 0}</small>
                </button>
              ))}
            </div>
            <div className="relation-layer-divider" />
            <div className="section-heading">
              <span>관계 유형</span>
              <span>{activeRelations.size || "ALL"}</span>
            </div>
            <div className="relation-list">
              {(Object.keys(relationLabels) as RelationKind[])
                .filter((relation) => (relationCounts.get(relation) ?? 0) > 0 || activeRelations.has(relation))
                .map((relation) => (
                <button
                  key={relation}
                  type="button"
                  className={activeRelations.has(relation) ? "is-active" : ""}
                  aria-pressed={activeRelations.has(relation)}
                  onClick={() => toggleRelation(relation)}
                >
                  <i
                    style={{
                      color: RELATION_STYLES[relation].color,
                      borderTopStyle:
                        RELATION_STYLES[relation].dash === "solid"
                          ? "solid"
                          : "dashed",
                    }}
                  />
                  <span>{relationLabels[relation]}</span>
                  <small>{relationCounts.get(relation)}</small>
                </button>
              ))}
            </div>
          </section>

          <footer className="sidebar-hint">
            <p>드래그로 회전 · 우클릭 드래그로 이동</p>
            <p>스크롤로 확대 · 노드를 클릭해 관계 탐색</p>
          </footer>
        </div>
      </aside>

      <section className="graph-stage" ref={stageRef} aria-label="AI 지식 그래프">
        <div className="graph-atmosphere" aria-hidden="true" />
        <div className="canvas-host" ref={canvasHostRef} />

        <button
          type="button"
          className="mobile-filter-button"
          onClick={() => setSidebarOpen(true)}
          aria-label="지식 그래프 필터 열기"
        >
          <span />
          <span />
          <span />
        </button>

        <div className="top-command">
          <div className="top-context">
            <span className="context-dot" />
            <span>AI SYSTEMS</span>
            <i>/</i>
            {documentScopeContext ? (
              <>
                <button
                  type="button"
                  disabled={graphLoading}
                  onClick={() => void navigateGraphScope("corpus")}
                >
                  전체 D1
                </button>
                <i>/</i>
                <span>{graphData.meta.documentName ?? "문서 중심 그래프"}</span>
              </>
            ) : repositoryScopeContext ? (
              <>
                <button
                  type="button"
                  disabled={graphLoading}
                  onClick={() => void navigateGraphScope("overview")}
                >
                  전체 저장소
                </button>
                <i>/</i>
                <span>{currentRepositoryNode?.shortLabel ?? graphData.meta.repositoryId}</span>
              </>
            ) : (
              <span>{corpusScopeActive
                ? publicStaticMode ? "공개 지식 코퍼스" : "전체 D1 코퍼스"
                : overviewScopeActive
                  ? "전체 저장소"
                  : selectedNode?.shortLabel ?? "전체 지식 우주"}</span>
            )}
          </div>
          <div className="search-shell">
            <span className="search-icon" aria-hidden="true" />
            <input
              type="search"
              value={query}
              placeholder="전체 코퍼스 노드 검색"
              aria-label="전체 지식 코퍼스 노드 검색"
              onFocus={() => setSearchOpen(true)}
              onChange={(event) => {
                const nextQuery = event.target.value;
                setQuery(nextQuery);
                setIndexedSearchResults([]);
                if (nextQuery.trim().length < 2) {
                  setIndexedSearchLoading(false);
                }
                setSearchOpen(true);
              }}
            />
            <kbd>⌘ K</kbd>
            {searchOpen && query && (
              <div className="search-results" role="listbox">
                {searchResults.length > 0 ? (
                  searchResults.map((item) => (
                    <button
                      key={item.node.id}
                      type="button"
                      role="option"
                      aria-selected={false}
                      onClick={() => void openSearchResult(item)}
                    >
                      <i
                        style={{ background: `#${NODE_COLORS[item.node.kind].toString(16).padStart(6, "0")}` }}
                      />
                      <span>
                        <strong>{item.node.shortLabel}</strong>
                        <small>
                          {nodeKindLabels[item.node.kind]} · {domainLabels[item.node.domain]}
                        </small>
                        <em className={item.inCurrentProjection ? "is-current" : "is-outside"}>
                          {item.inCurrentProjection
                            ? "현재 화면 · 궤도로 열기"
                            : `${item.document?.fileName ?? "연결 문서"} · 문서 중심 1·2단계`}
                        </em>
                      </span>
                    </button>
                  ))
                ) : indexedSearchLoading ? (
                  <p>전체 코퍼스에서 검색 중…</p>
                ) : (
                  <p>일치하는 지식 노드가 없습니다.</p>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="graph-title-block">
          <p>
            INTERACTIVE KNOWLEDGE · {goldGraphActive
              ? "ONTOLOGY V1 · REVIEW SAMPLE"
              : documentScopeContext
              ? "DOCUMENT · 1–2 HOP EVIDENCE"
              : repositoryScopeContext
              ? "REPOSITORY DETAIL"
              : corpusScopeActive
                ? "FULL CORPUS PROJECTION"
              : overviewScopeActive
                ? "REPOSITORY OVERVIEW"
                : VIEW_LABELS[viewMode].toUpperCase()}
          </p>
          <h2>
            {goldGraphActive
              ? <>검증된 프로젝트 구조 표본을<br />근거 관계로 탐색합니다.</>
              : documentScopeContext
              ? <>{graphData.meta.documentName ?? "선택 문서"}에서 시작해<br />1·2단계 근거 관계를 추적합니다.</>
              : repositoryScopeContext
              ? <>{currentRepositoryNode?.shortLabel ?? "선택 저장소"}의 문서와 계획을<br />관계로 추적합니다.</>
              : corpusScopeActive
                ? <>전체 문서의 핵심 지식을<br />관계 중심으로 조망합니다.</>
              : overviewScopeActive
                ? <>저장소와 공유 기술을<br />관계로 조망합니다.</>
                : <>
                    {viewMode === "constellation" && <>AI가 작동하는 구조를<br />관계로 탐색합니다.</>}
                    {viewMode === "nebula" && <>지식의 밀도와 경계를<br />성운으로 조망합니다.</>}
                    {viewMode === "orbit" && <>선택한 지식 주변의<br />1·2단계 관계를 추적합니다.</>}
                  </>}
          </h2>
          <span>
            {goldGraphActive
              ? `${graphData.meta.documentCount ?? 0}개 대표 문서 기반 검토 표본 · ${knowledgeNodes.length}개 전문 노드 · ${knowledgeEdges.length}개 근거 관계 · 전체 코퍼스 아님`
              : documentScopeContext
              ? `${graphData.meta.documentSourceLabel ?? "Markdown"} · 문서 직접 노드 ${(graphData.meta.documentSeedNodeIds?.length ?? 0).toLocaleString()}개 · 화면 ${knowledgeNodes.length.toLocaleString()}노드 · 저장 관계 ${knowledgeEdges.length.toLocaleString()}개 · 화면용 비저장선 0개`
              : repositoryScopeContext
              ? `${graphData.meta.documentCount ?? 0}개 Markdown · ${knowledgeNodes.length}개 노드 · ${knowledgeEdges.length}개 관계`
              : corpusScopeActive
                ? `${publicStaticMode ? "공개 원본" : "D1 전체"} ${(graphData.meta.corpusNodeCount ?? 0).toLocaleString()}노드 · ${(graphData.meta.corpusEdgeCount ?? 0).toLocaleString()}관계 중 화면 ${knowledgeNodes.length}노드 · 실제 ${(graphData.meta.projectedFactualEdgeCount ?? knowledgeEdges.length).toLocaleString()}관계${(graphData.meta.displayEdgeCount ?? 0) > 0 ? ` + 시각 연결 ${graphData.meta.displayEdgeCount?.toLocaleString()}` : ""}`
              : overviewScopeActive
                ? `${graphData.meta.repositoryCount ?? 0}개 저장소 · 공유 기술 중심 overview`
                : graphData.meta.source === "documents"
                  ? `${graphData.meta.documentCount ?? 0}개 Markdown 문서에서 추출한 관계 데이터`
                  : "개념과 시스템 사이를 연결한 선행 데모 데이터"}
          </span>
          {corpusScopeActive && (
            <small className="projection-guide">
              {publicStaticMode
                ? `GitHub에 공개 검증된 ${(graphData.meta.corpusNodeCount ?? 0).toLocaleString()}개 노드 중 핵심 ${knowledgeNodes.length.toLocaleString()}개를 정적 JSON으로 표시합니다.`
                : `화면은 전체 ${(graphData.meta.corpusNodeCount ?? 0).toLocaleString()}개 노드 중 핵심 500개 투영입니다. 상단 검색으로 화면 밖 노드를 찾으면 해당 Markdown 중심의 1·2단계 관계를 궤도로 엽니다.`}
            </small>
          )}
          {goldGraphActive && (
            <button
              type="button"
              className="gold-corpus-cta"
              disabled={graphLoading}
              onClick={() => void selectDataSource("corpus")}
            >
              <span>Gold 표본 닫기</span>
              <strong>{publicStaticMode ? "공개 연결망 보기" : "실제 D1 연결망 보기"}</strong>
              <i aria-hidden="true">→</i>
            </button>
          )}
          {graphError && (
            <span className="graph-sync-error" role="alert">
              <span>{graphError}</span>
              <button type="button" onClick={() => void loadGraph()} disabled={graphLoading}>
                다시 시도
              </button>
            </span>
          )}
        </div>

        <div
          className="graph-controls"
          aria-label="그래프 화면 제어"
          aria-describedby="graph-controls-scroll-hint"
        >
          <span id="graph-controls-scroll-hint" className="control-scroll-hint">
            작은 화면에서는 가로로 스크롤하여 모든 제어를 확인할 수 있습니다.
          </span>
          <output
            className="control-status"
            aria-label={`현재 제어 상태: ${controlStatusLabel}`}
            aria-live="polite"
          >
            <i aria-hidden="true" />
            <span>
              <strong>{VIEW_LABELS[viewMode]}</strong>
              <small>{controlDataStatus} · {controlLuminosityStatus}</small>
            </span>
          </output>

          <div className="control-cluster view-cluster" role="group" aria-label="보기">
            <span className="control-cluster-label" aria-hidden="true">보기</span>
            <div className="control-group view-switch" aria-label="그래프 보기">
              {(Object.keys(VIEW_LABELS) as GraphViewMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={viewMode === mode ? "is-active" : ""}
                  aria-pressed={viewMode === mode}
                  onClick={() => changeViewMode(mode)}
                  title={`${VIEW_LABELS[mode]} 보기 · V 키로 순환`}
                >
                  <span className={`view-icon view-icon-${mode}`} aria-hidden="true" />
                  <em>{VIEW_LABELS[mode]}</em>
                </button>
              ))}
            </div>
          </div>

          <div className="control-cluster data-cluster" role="group" aria-label="데이터">
            <span className="control-cluster-label" aria-hidden="true">데이터</span>
            <div className="control-group data-switch">
              {!publicStaticMode && (repositoryScopeContext || documentScopeContext) && (
                <button
                  type="button"
                  className="scope-back-control"
                  disabled={graphLoading}
                  onClick={() => void navigateGraphScope(documentScopeContext ? "corpus" : "overview")}
                  title={documentScopeContext ? "전체 D1 코퍼스로 복귀" : "전체 저장소 overview로 복귀"}
                >
                  <span className="scope-back-icon" aria-hidden="true">←</span>
                  <em>{documentScopeContext ? "전체 D1" : "전체 저장소"}</em>
                </button>
              )}
              {!publicStaticMode && (
                <a className="dashboard-control" href="/dashboard" title="Markdown 문서 관리">
                  <span className="data-icon">＋</span>
                  <em>문서 관리</em>
                </a>
              )}
              <button
                ref={dataMenuButtonRef}
                type="button"
                className={`data-source-control ${presentationFixtureActive ? "is-active" : ""}`}
                aria-expanded={dataMenuOpen}
                aria-controls="graph-data-source-panel"
                aria-haspopup="dialog"
                aria-label={
                  goldGraphActive
                    ? "온톨로지 v1 Gold Graph 대표 문서 검토 표본 사용 중: 전체 데이터가 아닙니다"
                    : showcaseActive
                      ? "최대 밀도 데모 데이터 사용 중: 실제 지식 데이터가 아니며 읽기 전용입니다"
                    : "그래프 데이터 선택"
                }
                onClick={toggleDataMenu}
                title="그래프 데이터 선택"
              >
                <span className="data-source-icon" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                  <i />
                </span>
                <em>{goldGraphActive
                  ? "Gold Graph"
                  : showcaseActive
                    ? "최대 밀도"
                    : corpusScopeActive
                      ? publicStaticMode ? "공개 지식" : "전체 D1"
                      : overviewScopeActive
                        ? "저장소 맵"
                        : repositoryScopeActive
                          ? "저장소 상세"
                          : documentScopeActive
                            ? "문서 중심"
                          : "데이터"}</em>
              </button>
            </div>
          </div>

          <div className="control-cluster stage-cluster" role="group" aria-label="연출">
            <span className="control-cluster-label" aria-hidden="true">연출</span>
            <div className="control-group utility-switch">
              <button
                type="button"
                onClick={() => graphApiRef.current?.reset()}
                title="화면 중앙으로 재정렬"
              >
                <span className="reset-icon">↻</span>
                <em>재정렬</em>
              </button>
              <button
                type="button"
                className={autoRotate ? "is-active" : ""}
                aria-pressed={autoRotate}
                aria-describedby={prefersReducedMotion ? "auto-rotate-motion-status" : undefined}
                onClick={() => updateAutoRotateIntent(toggleAutoRotateIntent(autoRotateIntentRef.current))}
                title={autoRotateStatus}
              >
                <span className="orbit-icon" />
                <em>자동 회전</em>
              </button>
              {prefersReducedMotion && <span
                id="auto-rotate-motion-status"
                className="motion-preference-status"
                role="status"
                aria-live="polite"
              >{autoRotateStatus}</span>}
              <button
                type="button"
                className={labelsVisible ? "is-active" : ""}
                aria-pressed={labelsVisible}
                onClick={() => setLabelsVisible((value) => !value)}
                title="핵심 주장 라벨"
              >
                <span className="label-icon">Aa</span>
                <em>라벨</em>
              </button>
            </div>
            <span className="control-subseparator" aria-hidden="true" />
            <div className="control-group luminosity-switch" aria-label="발광 강도">
              {(Object.keys(LUMINOSITY_LABELS) as LuminosityPreset[]).map((preset) => (
                <button
                  key={preset}
                  type="button"
                  data-preset={preset}
                  className={!luminosityCustom && luminosity === preset ? "is-active" : ""}
                  aria-pressed={!luminosityCustom && luminosity === preset}
                  onClick={() => selectLuminosityPreset(preset)}
                  title={`${LUMINOSITY_LABELS[preset]} 발광`}
                >
                  <span className={`light-icon light-icon-${preset}`} aria-hidden="true" />
                  <em>{LUMINOSITY_LABELS[preset]}</em>
                </button>
              ))}
              <button
                ref={luminosityButtonRef}
                type="button"
                className={`luminosity-adjust-button ${savedCustomControls ? "has-custom" : ""} ${luminosityCustom ? "is-custom" : ""}`}
                aria-pressed={luminosityCustom}
                aria-expanded={luminosityPanelOpen}
                aria-controls="luminosity-control-panel"
                onClick={openOrRestoreCustomLuminosity}
                title={
                  savedCustomControls && !luminosityCustom
                    ? "마지막 커스텀 설정 복원"
                    : "발광 세부 조절"
                }
              >
                <span className="adjust-icon" aria-hidden="true">✦</span>
                <em>커스텀</em>
              </button>
            </div>
          </div>
        </div>

        {dataMenuOpen && (
          <section
            ref={dataMenuPanelRef}
            id="graph-data-source-panel"
            className="data-source-panel"
            role="dialog"
            aria-label="그래프 데이터 선택"
            style={{ left: dataMenuPosition.left, bottom: dataMenuPosition.bottom }}
          >
            <header>
              <span>{goldGraphActive
                ? "REVIEW SAMPLE · EVIDENCE BACKED"
                : showcaseActive
                  ? "DEMO · 500 NODES / 2,000 EDGES"
                  : corpusScopeActive
                    ? publicStaticMode ? "STATIC JSON · VERIFIED PUBLIC DATA" : "LIVE D1 · RELATIONSHIP FIRST"
                    : documentScopeActive
                      ? "DOCUMENT · STORED EVIDENCE"
                    : "DATA SOURCE"}</span>
              <strong>{goldGraphActive
                ? "GOLD GRAPH SAMPLE"
                : showcaseActive
                  ? "MAX DENSITY"
                  : corpusScopeActive
                    ? "FULL CORPUS MAP"
                    : overviewScopeActive
                      ? "REPOSITORY OVERVIEW"
                      : repositoryScopeActive
                        ? "REPOSITORY DETAIL"
                        : documentScopeActive
                          ? "DOCUMENT EVIDENCE MAP"
                        : "CURRENT GRAPH"}</strong>
            </header>
            <div className="data-source-options">
              {presentationFixtureActive && (
                <button
                  type="button"
                  aria-pressed={false}
                  disabled={graphLoading}
                  onClick={() => void selectDataSource("current")}
                >
                  <i className="data-option-current" aria-hidden="true" />
                  <span>
                    <strong>이전 실제 그래프로 복귀</strong>
                    <small>쇼케이스 진입 전 범위와 화면 상태 복원</small>
                  </span>
                  <b>RETURN</b>
                </button>
              )}
              <button
                type="button"
                className={corpusScopeActive ? "is-active" : ""}
                aria-pressed={corpusScopeActive}
                disabled={graphLoading}
                onClick={() => void selectDataSource("corpus")}
              >
                <i className="data-option-current" aria-hidden="true" />
                <span>
                  <strong>{publicStaticMode ? "공개 정적 지식 맵" : "전체 D1 지식 맵"}</strong>
                  <small>
                    {corpusScopeActive
                      ? `${(graphData.meta.projectedFactualEdgeCount ?? knowledgeEdges.length).toLocaleString()}개 실제 관계 + ${(graphData.meta.displayEdgeCount ?? 0).toLocaleString()}개 시각 연결`
                      : publicStaticMode
                        ? "GitHub 공개 snapshot · 500노드 관계 투영"
                        : "실제 문서 코퍼스 · 500노드 관계 확장 투영"}
                  </small>
                </span>
                <b>{corpusScopeActive ? "ACTIVE" : "OPEN"}</b>
              </button>
              {!publicStaticMode && (
                <button
                  type="button"
                  className={overviewScopeActive ? "is-active" : ""}
                  aria-pressed={overviewScopeActive}
                  disabled={graphLoading}
                  onClick={() => void selectDataSource("overview")}
                >
                  <i className="data-option-overview" aria-hidden="true" />
                  <span>
                    <strong>저장소 Overview</strong>
                    <small>{graphData.meta.repositoryCount ?? 0}개 저장소와 공유 기술 중심 맵</small>
                  </span>
                  <b>{overviewScopeActive ? "ACTIVE" : "OPEN"}</b>
                </button>
              )}
              <button
                type="button"
                className={goldGraphActive ? "is-active is-gold" : "is-gold"}
                aria-pressed={goldGraphActive}
                disabled={graphLoading}
                onClick={() => void selectDataSource("gold")}
              >
                <i className="data-option-gold" aria-hidden="true" />
                <span>
                  <strong>온톨로지 Gold Graph</strong>
                  <small>대표 문서 3개 검토 표본 · 68노드 · 101관계 · 전체 아님</small>
                </span>
                <b>{goldGraphActive ? "ACTIVE" : "REVIEW"}</b>
              </button>
              <button
                type="button"
                className={showcaseActive ? "is-active is-showcase" : "is-showcase"}
                aria-pressed={showcaseActive}
                disabled={graphLoading}
                onClick={() => void selectDataSource("max")}
              >
                <i className="data-option-max" aria-hidden="true" />
                <span>
                  <strong>최대 밀도 쇼케이스</strong>
                  <small>DEMO · 500 노드 · 2,000 관계 시각 샘플</small>
                </span>
                <b>{showcaseActive ? "ACTIVE" : "VIEW"}</b>
              </button>
              {recentDocuments.length > 0 && (
                <div className="recent-document-options" aria-label="최근 Markdown 문서">
                  <div>
                    <span>RECENT DOCUMENTS</span>
                    <small>문서 직접 노드 + 1·2단계 저장 관계</small>
                  </div>
                  {recentDocuments.map((document) => (
                    <button
                      key={document.id}
                      type="button"
                      className={documentScopeActive && graphData.meta.documentId === document.id ? "is-active" : ""}
                      aria-pressed={documentScopeActive && graphData.meta.documentId === document.id}
                      disabled={graphLoading}
                      onClick={() => void navigateGraphScope("document", document.id)}
                    >
                      <span>
                        <strong>{document.fileName}</strong>
                        <small>{document.sourceLabel} · {document.nodeCount.toLocaleString()}N / {document.edgeCount.toLocaleString()}E</small>
                      </span>
                      <b>{documentScopeActive && graphData.meta.documentId === document.id ? "ACTIVE" : "OPEN"}</b>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <footer role="status" aria-live="polite">
              <i aria-hidden="true" />
              {goldGraphActive
                ? `검토 표본 · 전체 코퍼스 아님 · ${publicStaticMode ? "공개 snapshot" : "D1"}과 분리 · 저장되지 않음`
                  : showcaseActive
                  ? "읽기 전용 · 저장되지 않음 · 실제 지식 데이터 아님"
                  : documentScopeActive
                    ? "문서 직접 노드 중심 · 저장된 관계만 표시 · 1·2단계 확장 · 화면용 연결선 0개"
                  : `${publicStaticMode ? "GitHub 공개 JSON" : "실제 D1"} 읽기 전용 투영 · 화면 상한 500노드 / 2,000선${(graphData.meta.displayEdgeCount ?? 0) > 0 ? ` · 화면용 ${graphData.meta.displayEdgeCount?.toLocaleString()}선은 비저장` : ""}`}
            </footer>
          </section>
        )}

        {luminosityPanelOpen && (
          <section
            ref={luminosityPanelRef}
            id="luminosity-control-panel"
            className="luminosity-panel"
            role="dialog"
            aria-label="발광 세부 조절"
          >
            <header>
              <div>
                <span>LUMINOSITY CONTROL</span>
                <strong>
                  {luminosityCustom
                    ? "CUSTOM"
                    : LUMINOSITY_LABELS[luminosity].toUpperCase()}
                </strong>
              </div>
              <button
                type="button"
                onClick={() => setLuminosityPanelOpen(false)}
                aria-label="발광 조절 닫기"
              >
                ×
              </button>
            </header>

            <div className="luminosity-slider-list">
              {([
                ["overall", "전체 밝기", 50, 150],
                ["edges", "관계선", 20, 100],
                ["bloom", "후광", 0, 100],
                ["particles", "배경 입자", 0, 100],
              ] as const).map(([controlKey, label, min, max]) => {
                const value = luminosityControls[controlKey];
                return (
                  <label key={controlKey}>
                    <span>
                      <b>{label}</b>
                      <output>{value}%</output>
                    </span>
                    <input
                      type="range"
                      min={min}
                      max={max}
                      step="1"
                      value={value}
                      aria-label={label}
                      aria-valuetext={`${value}%`}
                      onChange={(event) =>
                        updateLuminosityControl(controlKey, Number(event.target.value))
                      }
                    />
                  </label>
                );
              })}
            </div>

            <fieldset className="focus-contrast-control">
              <legend>선택 영역 대비</legend>
              <div className="focus-contrast-options">
                {([
                  ["low", "낮음"],
                  ["medium", "보통"],
                  ["high", "강함"],
                ] as Array<[FocusContrast, string]>).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    className={luminosityControls.focusContrast === value ? "is-active" : ""}
                    aria-pressed={luminosityControls.focusContrast === value}
                    onClick={() => updateFocusContrast(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div
                className="focus-contrast-preview"
                data-contrast={luminosityControls.focusContrast}
                aria-hidden="true"
              >
                <i />
                <span />
                <i />
                <span />
                <i />
              </div>
              <p className={hasFocus ? "is-applied" : ""} aria-live="polite">
                {hasFocus
                  ? "현재 선택 영역에 즉시 적용 중"
                  : "전체 우주에서는 변화 없음 · 노드 또는 렌즈 선택 시 적용"}
              </p>
            </fieldset>

            <footer>
              <span aria-live="polite">
                {luminosityCustom
                  ? `커스텀 · ${luminosityControls.overall}%`
                  : `${LUMINOSITY_LABELS[luminosity]} 프리셋${savedCustomControls ? " · 커스텀 저장됨" : ""}`}
              </span>
              <button type="button" onClick={resetLuminosityControls}>
                {savedCustomControls ? "커스텀 초기화" : "프리셋으로 초기화"}
              </button>
            </footer>
          </section>
        )}

        <div className="stage-footer">
          <span>{goldGraphActive
            ? "EVIDENCE GOLD SAMPLE"
            : graphData.meta.source === "documents"
              ? "MARKDOWN KNOWLEDGE"
              : "AI KNOWLEDGE PROTOTYPE"}</span>
          <i />
          <span>THREE.JS · FORCE 3D · GPU BLOOM</span>
          <strong>01</strong>
        </div>

        {performanceEnabled && (
          <output
            className="performance-hud"
            aria-label="그래프 렌더링 성능"
            data-fps={performanceMetrics?.fps ?? 0}
            data-p95-frame-ms={performanceMetrics?.p95FrameMs ?? 0}
            data-quality={performanceMetrics?.quality ?? "measuring"}
          >
            <span>PERFORMANCE · {knowledgeNodes.length}N / {knowledgeEdges.length}E</span>
            {performanceMetrics ? (
              <strong>
                {performanceMetrics.fps} FPS · P95 {performanceMetrics.p95FrameMs}MS · {performanceMetrics.quality.toUpperCase()}
              </strong>
            ) : (
              <strong>MEASURING 2S WINDOW…</strong>
            )}
            {performanceMetrics && (
              <small>
                {performanceMetrics.drawCalls} DRAWS · {performanceMetrics.geometries} GEOMETRIES
                {performanceMetrics.heapMb ? ` · ${performanceMetrics.heapMb}MB HEAP` : ""}
              </small>
            )}
          </output>
        )}

        {hovered && hoveredNode && !selectedNode && (
          <div
            id="graph-node-tooltip"
            role="tooltip"
            className="node-tooltip"
            style={{
              left: clamp(hovered.x + 18, 18, window.innerWidth - 330),
              top: clamp(hovered.y + 18, 18, window.innerHeight - 180),
            }}
          >
            <div>
              <span
                style={{
                  background: `#${NODE_COLORS[hoveredNode.kind].toString(16).padStart(6, "0")}`,
                }}
              />
              {nodeKindLabels[hoveredNode.kind]} · {domainLabels[hoveredNode.domain]}
            </div>
            <strong>{hoveredNode.shortLabel}</strong>
            <p>{hoveredNode.summary}</p>
            <small>클릭하여 관계 열기 ↗</small>
          </div>
        )}

        {selectedNode && (
          <aside className="detail-panel" aria-label="선택한 지식 노드 상세">
            <div className="detail-panel-glow" aria-hidden="true" />
            <header>
              <div>
                <span
                  className="detail-node-dot"
                  style={{
                    background: `#${NODE_COLORS[selectedNode.kind].toString(16).padStart(6, "0")}`,
                    boxShadow: `0 0 18px #${NODE_COLORS[selectedNode.kind].toString(16).padStart(6, "0")}`,
                  }}
                />
                {nodeKindLabels[selectedNode.kind]} · {domainLabels[selectedNode.domain]}
              </div>
              <button
                type="button"
                onClick={() => setSelectedId(null)}
                aria-label="상세 닫기"
              >
                ×
              </button>
            </header>
            <div className="detail-scroll">
              <p className="detail-index">
                NODE / {String(knowledgeNodes.indexOf(selectedNode) + 1).padStart(2, "0")}
              </p>
              <h2>{selectedNode.label}</h2>
              <p className="detail-summary">{selectedNode.summary}</p>

              {!publicStaticMode && selectedRepositoryId && !repositoryScopeActive && (
                <button
                  type="button"
                  className="detail-scope-action"
                  disabled={graphLoading}
                  onClick={() => void navigateGraphScope("repository", selectedRepositoryId)}
                >
                  <span>
                    <small>REPOSITORY SCOPE</small>
                    <strong>저장소 상세 그래프 열기</strong>
                  </span>
                  <em aria-hidden="true">→</em>
                </button>
              )}

              {(selectedNode.source || selectedTaskStatus || selectedNode.metrics) && (
                <section className="detail-source-card" aria-label="노드 원본 근거와 상태">
                  <div className="detail-source-card-heading">
                    <span>SOURCE / STATUS</span>
                    <i aria-hidden="true" />
                  </div>
                  <dl>
                    {selectedNode.metrics && (
                      <>
                        <dt>Community</dt>
                        <dd>{selectedNode.metrics.communityId}</dd>
                        <dt>Centrality</dt>
                        <dd>{Math.round(selectedNode.metrics.centrality * 100)}% · degree {selectedNode.metrics.degree}{selectedNode.metrics.bridge ? " · bridge" : ""}</dd>
                      </>
                    )}
                    {selectedTaskStatus && (
                      <>
                        <dt>Task</dt>
                        <dd>
                          <span
                            className="detail-task-status"
                            data-status={selectedTaskStatus}
                          >
                            {selectedTaskStatus === "completed"
                              ? "완료"
                              : selectedTaskStatus === "pending"
                                ? "미완료"
                                : "상태 미정"}
                          </span>
                        </dd>
                      </>
                    )}
                    {selectedNode.source && (
                      <>
                        <dt>Repository</dt>
                        <dd>{selectedNode.source.repositoryOwner}/{selectedNode.source.repositoryName}</dd>
                        <dt>Path</dt>
                        <dd title={selectedNode.source.relativePath}>{selectedNode.source.relativePath}</dd>
                        <dt>Commit</dt>
                        <dd>
                          <code title={selectedNode.source.commitSha}>
                            {selectedNode.source.commitSha.slice(0, 12)}
                          </code>
                        </dd>
                      </>
                    )}
                  </dl>
                  {selectedNode.source && (
                    <a
                      href={selectedNode.source.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      GitHub 원문 근거 열기 <span aria-hidden="true">↗</span>
                    </a>
                  )}
                </section>
              )}

              <div className="detail-divider" />
              <section>
                <h3>핵심 해석</h3>
                <p>{selectedNode.insight}</p>
              </section>
              <section>
                <h3>키워드</h3>
                <div className="detail-tags">
                  {selectedNode.tags.map((tag) => (
                    <span key={tag}>#{tag}</span>
                  ))}
                </div>
              </section>
              <section>
                <h3>
                  연결된 지식 <span>{connectedItems.length}</span>
                </h3>
                <div className="connection-list">
                  {connectedItems.map((item) => {
                    const layer = relationLayerForEdge(item.edge);
                    const evidence = item.edge.evidence?.[0];
                    return (
                      <div className="connection-item" key={edgeId(item.edge)}>
                        <button
                          type="button"
                          onClick={() => item.node && selectNode(item.node.id)}
                        >
                          <i
                            style={{
                              borderColor: RELATION_STYLES[item.edge.type].color,
                              borderTopStyle: RELATION_LAYER_STYLES[layer].dash === "solid" ? "solid" : "dashed",
                            }}
                          />
                          <span>
                            <small>
                              {RELATION_LAYER_LABELS[layer]} · {relationLabels[item.edge.type]} · {Math.round(item.edge.confidence * 100)}%
                            </small>
                            <strong>{item.node?.shortLabel}</strong>
                          </span>
                          <em>{item.outgoing ? "→" : "←"}</em>
                        </button>
                        {evidence && (
                          <div className="connection-evidence">
                            <span title={evidence.explanation}>{evidence.explanation}</span>
                            {evidence.sourceUrl && (
                              <a href={evidence.sourceUrl} target="_blank" rel="noreferrer">
                                원문 근거 ↗
                              </a>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            </div>
          </aside>
        )}
      </section>
    </main>
  );
}
