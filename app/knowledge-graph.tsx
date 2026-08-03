"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
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
  knowledgeEdges as demoEdges,
  knowledgeNodes as demoNodes,
  nodeKindLabels,
  relationLabels,
  type Domain,
  type KnowledgeEdge,
  type KnowledgeNode,
  type NodeKind,
  type RelationKind,
} from "./graph-data";
import type { GraphSnapshot } from "./lib/graph/model";
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
  setAutoRotate: (value: boolean) => void;
  setLabelsVisible: (value: boolean) => void;
  setViewMode: (mode: GraphViewMode, selectedId?: string | null) => void;
  setLuminosity: (preset: LuminosityPreset) => void;
  setLuminosityControls?: (controls: LuminosityControls) => void;
};

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
  supports: { color: "#d8d1c1", dash: "solid" },
  extends: { color: "#9f7aea", dash: "solid" },
  requires: { color: "#65b5ff", dash: "short" },
  uses: { color: "#79d5c0", dash: "short" },
  mitigates: { color: "#f3b35b", dash: "solid" },
  risks: { color: "#ff6678", dash: "long" },
  contradicts: { color: "#ff473d", dash: "long" },
};

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
): [Set<T>, (value: T) => void, () => void] {
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
  return [set, toggle, clear];
}

export default function KnowledgeGraph() {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const graphApiRef = useRef<GraphApi | null>(null);
  const focusRef = useRef<FocusState>(emptyFocusState());
  const luminosityButtonRef = useRef<HTMLButtonElement>(null);
  const luminosityPanelRef = useRef<HTMLElement>(null);
  const dataMenuButtonRef = useRef<HTMLButtonElement>(null);
  const dataMenuPanelRef = useRef<HTMLElement>(null);
  const urlInitializedRef = useRef(false);
  const viewModeRef = useRef<GraphViewMode>("constellation");
  const luminosityRef = useRef<LuminosityPreset>("bright");
  const luminosityPreviewRef = useRef(false);
  const luminosityControlsRef = useRef<LuminosityControls>({
    ...luminosityPresetControls.bright,
  });
  const selectedIdRef = useRef<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hovered, setHovered] = useState<{
    id: string;
    x: number;
    y: number;
  } | null>(null);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [autoRotate, setAutoRotate] = useState(true);
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
  const [luminosityPreviewEnabled, setLuminosityPreviewEnabled] = useState(false);
  const [graphLoading, setGraphLoading] = useState(false);
  const [graphError, setGraphError] = useState("");
  const [performanceEnabled, setPerformanceEnabled] = useState(false);
  const [performanceMetrics, setPerformanceMetrics] = useState<PerformanceMetrics | null>(null);
  const [graphData, setGraphData] = useState<GraphSnapshot>({
    nodes: demoNodes,
    edges: demoEdges,
    meta: {
      source: "demo",
      provider: "built-in",
      generatedAt: "",
    },
  });
  const [activeLens, setActiveLens] = useState("all");
  const [activeDomains, toggleDomain, clearDomains] = useSetToggle<Domain>();
  const [activeKinds, toggleKind, clearKinds] = useSetToggle<NodeKind>();
  const [activeRelations, toggleRelation, clearRelations] =
    useSetToggle<RelationKind>();

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

  const loadGraph = useCallback(async () => {
    setGraphLoading(true);
    setGraphError("");
    try {
      const graphUrl = new URL("/api/graph", window.location.origin);
      const pageParams = new URL(window.location.href).searchParams;
      const showcase = pageParams.get("showcase");
      const fixture = pageParams.get("fixture");
      if (showcase) graphUrl.searchParams.set("showcase", showcase);
      if (fixture) graphUrl.searchParams.set("fixture", fixture);
      const response = await fetch(`${graphUrl.pathname}${graphUrl.search}`, { cache: "no-store" });
      const payload = (await response.json()) as GraphSnapshot & { error?: string };
      if (!response.ok) throw new Error(payload.error || `그래프 요청 실패 (${response.status})`);
      if (!Array.isArray(payload.nodes) || !Array.isArray(payload.edges)) {
        throw new Error("그래프 응답 형식이 올바르지 않습니다.");
      }
      setSelectedId(null);
      setGraphData(payload);
    } catch (error) {
      setGraphError(error instanceof Error ? error.message : "그래프를 불러오지 못했습니다.");
    } finally {
      setGraphLoading(false);
    }
  }, []);

  const positionDataMenu = useCallback(() => {
    const bounds = dataMenuButtonRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const panelWidth = Math.min(310, window.innerWidth - 24);
    setDataMenuPosition({
      left: clamp(bounds.left, 12, window.innerWidth - panelWidth - 12),
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

  const selectDataSource = useCallback(
    async (source: "current" | "max") => {
      const url = new URL(window.location.href);
      if (source === "max") url.searchParams.set("showcase", "max");
      else url.searchParams.delete("showcase");
      url.searchParams.delete("fixture");
      url.searchParams.delete("node");
      window.history.replaceState({}, "", url);
      setDataMenuOpen(false);
      await loadGraph();
      dataMenuButtonRef.current?.focus();
    },
    [loadGraph],
  );

  useEffect(() => {
    const previewEnabled =
      new URL(window.location.href).searchParams.get("preview") === "luminosity-v2";
    luminosityPreviewRef.current = previewEnabled;
    const frame = window.requestAnimationFrame(() => {
      setLuminosityPreviewEnabled(previewEnabled);
      setPerformanceEnabled(new URL(window.location.href).searchParams.get("perf") === "1");
      void loadGraph();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [loadGraph]);

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

  const selectedNode = selectedId ? nodeMap.get(selectedId) ?? null : null;
  const showcaseActive = graphData.meta.provider === "performance-fixture";
  const controlDataStatus = graphLoading
    ? "SYNC"
    : showcaseActive
      ? `MAX ${knowledgeNodes.length}N`
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
    return knowledgeNodes
      .filter((item) =>
        [item.label, item.summary, item.tags.join(" ")]
          .join(" ")
          .toLowerCase()
          .includes(normalized),
      )
      .sort(
        (a, b) => (degreeMap.get(b.id) ?? 0) - (degreeMap.get(a.id) ?? 0),
      )
      .slice(0, 6);
  }, [degreeMap, knowledgeNodes, query]);

  const applyLens = useCallback(
    (lens: string) => {
      setActiveLens(lens);
      clearDomains();
      clearKinds();
      clearRelations();
      setSelectedId(null);

      const lensDomains: Record<string, Domain[]> = {
        agents: ["agents"],
        memory: ["memory"],
        safety: ["safety"],
        product: ["product"],
      };

      (lensDomains[lens] ?? []).forEach(toggleDomain);
    },
    [clearDomains, clearKinds, clearRelations, toggleDomain],
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

  useEffect(() => {
    const nodeIds = new Set<string>();
    const edgeIds = new Set<string>();
    const hasFilters =
      activeDomains.size > 0 ||
      activeKinds.size > 0 ||
      activeRelations.size > 0;

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
        if (
          relationMatch &&
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
  }, [activeDomains, activeKinds, activeRelations, knowledgeEdges, knowledgeNodes, selectedId, viewMode]);

  useEffect(() => {
    graphApiRef.current?.setAutoRotate(autoRotate);
  }, [autoRotate]);

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
  }, [graphData.nodes]);

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
    controls.autoRotate = !reducedMotion;
    controls.autoRotateSpeed = 0.32;
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

      const sourceColor = new THREE.Color(
        NODE_COLORS[simNodes[sourceIndex].kind],
      ).lerp(new THREE.Color("#f2eee5"), 0.32);
      const targetColor = new THREE.Color(
        NODE_COLORS[simNodes[targetIndex].kind],
      ).lerp(new THREE.Color("#f2eee5"), 0.32);
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
    const edgeMaterial = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.54,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
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
        copy.append(title, detail);
        element.append(rail, copy, count);
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
      setAutoRotate: (value) => {
        controls.autoRotate = value && !reducedMotion;
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
    activeRelations.size > 0;

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
                KNOWLEDGE GRAPH · {graphData.meta.source === "documents" ? "DOCUMENTS LIVE" : "DEMO 01"}
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
              <i /> {graphLoading ? "SYNC" : graphData.meta.source === "documents" ? "DOCS" : "DEMO"}
            </span>
          </div>

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
              <span>관계 유형</span>
              <span>{activeRelations.size || "ALL"}</span>
            </div>
            <div className="relation-list">
              {(Object.keys(relationLabels) as RelationKind[]).map((relation) => (
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
            <span>{selectedNode?.shortLabel ?? "전체 지식 우주"}</span>
          </div>
          <div className="search-shell">
            <span className="search-icon" aria-hidden="true" />
            <input
              type="search"
              value={query}
              placeholder="개념, 시스템, 위험 검색"
              aria-label="지식 노드 검색"
              onFocus={() => setSearchOpen(true)}
              onChange={(event) => {
                setQuery(event.target.value);
                setSearchOpen(true);
              }}
            />
            <kbd>⌘ K</kbd>
            {searchOpen && query && (
              <div className="search-results" role="listbox">
                {searchResults.length > 0 ? (
                  searchResults.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      role="option"
                      aria-selected={false}
                      onClick={() => selectNode(item.id)}
                    >
                      <i
                        style={{ background: `#${NODE_COLORS[item.kind].toString(16).padStart(6, "0")}` }}
                      />
                      <span>
                        <strong>{item.shortLabel}</strong>
                        <small>
                          {nodeKindLabels[item.kind]} · {domainLabels[item.domain]}
                        </small>
                      </span>
                    </button>
                  ))
                ) : (
                  <p>일치하는 지식 노드가 없습니다.</p>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="graph-title-block">
          <p>INTERACTIVE KNOWLEDGE · {VIEW_LABELS[viewMode].toUpperCase()}</p>
          <h2>
            {viewMode === "constellation" && <>AI가 작동하는 구조를<br />관계로 탐색합니다.</>}
            {viewMode === "nebula" && <>지식의 밀도와 경계를<br />성운으로 조망합니다.</>}
            {viewMode === "orbit" && <>선택한 지식 주변의<br />1·2단계 관계를 추적합니다.</>}
          </h2>
          <span>
            {graphData.meta.source === "documents"
              ? `${graphData.meta.documentCount ?? 0}개 Markdown 문서에서 추출한 관계 데이터`
              : "개념과 시스템 사이를 연결한 선행 데모 데이터"}
          </span>
          {graphError && <span className="graph-sync-error">{graphError}</span>}
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
              <Link className="dashboard-control" href="/dashboard" title="Markdown 문서 관리">
                <span className="data-icon">＋</span>
                <em>문서 관리</em>
              </Link>
              <button
                ref={dataMenuButtonRef}
                type="button"
                className={`data-source-control ${showcaseActive ? "is-active" : ""}`}
                aria-expanded={dataMenuOpen}
                aria-controls="graph-data-source-panel"
                aria-haspopup="dialog"
                aria-label={showcaseActive ? "최대 밀도 데이터 선택" : "그래프 데이터 선택"}
                onClick={toggleDataMenu}
                title="그래프 데이터 선택"
              >
                <span className="data-source-icon" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                  <i />
                </span>
                <em>{showcaseActive ? "최대 밀도" : "쇼케이스"}</em>
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
                onClick={() => setAutoRotate((value) => !value)}
                title="자동 회전"
              >
                <span className="orbit-icon" />
                <em>오비트</em>
              </button>
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
              {luminosityPreviewEnabled && (
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
                  <em>{savedCustomControls ? "커스텀" : "조절"}</em>
                </button>
              )}
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
              <span>DATA SOURCE</span>
              <strong>{showcaseActive ? "MAX DENSITY" : "CURRENT GRAPH"}</strong>
            </header>
            <div className="data-source-options">
              <button
                type="button"
                className={!showcaseActive ? "is-active" : ""}
                aria-pressed={!showcaseActive}
                disabled={graphLoading}
                onClick={() => void selectDataSource("current")}
              >
                <i className="data-option-current" aria-hidden="true" />
                <span>
                  <strong>현재 지식 데이터</strong>
                  <small>
                    {graphData.meta.source === "documents"
                      ? `Markdown 문서 ${graphData.meta.documentCount ?? 0}개`
                      : showcaseActive
                        ? "저장된 그래프로 복귀"
                        : `${knowledgeNodes.length} 노드 · ${knowledgeEdges.length} 관계`}
                  </small>
                </span>
                <b>{!showcaseActive ? "ACTIVE" : "RETURN"}</b>
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
                  <small>500 노드 · 2,000 관계 시각 샘플</small>
                </span>
                <b>{showcaseActive ? "ACTIVE" : "VIEW"}</b>
              </button>
            </div>
            <footer>
              <i aria-hidden="true" />
              저장되지 않는 읽기 전용 시각 샘플
            </footer>
          </section>
        )}

        {luminosityPreviewEnabled && luminosityPanelOpen && (
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
          <span>{graphData.meta.source === "documents" ? "MARKDOWN KNOWLEDGE" : "AI KNOWLEDGE PROTOTYPE"}</span>
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
                  {connectedItems.map((item) => (
                    <button
                      type="button"
                      key={edgeId(item.edge)}
                      onClick={() => item.node && selectNode(item.node.id)}
                    >
                      <i
                        style={{
                          borderColor: RELATION_STYLES[item.edge.type].color,
                        }}
                      />
                      <span>
                        <small>
                          {relationLabels[item.edge.type]} · {Math.round(item.edge.confidence * 100)}%
                        </small>
                        <strong>{item.node?.shortLabel}</strong>
                      </span>
                      <em>{item.outgoing ? "→" : "←"}</em>
                    </button>
                  ))}
                </div>
              </section>
            </div>
          </aside>
        )}
      </section>
    </main>
  );
}
