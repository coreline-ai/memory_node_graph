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
  knowledgeEdges,
  knowledgeNodes,
  nodeKindLabels,
  relationLabels,
  type Domain,
  type KnowledgeEdge,
  type KnowledgeNode,
  type NodeKind,
  type RelationKind,
} from "./graph-data";

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

type FocusState = {
  nodeIds: Set<string> | null;
  edgeIds: Set<string> | null;
};

type GraphApi = {
  reset: () => void;
  flyTo: (id: string) => void;
  setAutoRotate: (value: boolean) => void;
  setLabelsVisible: (value: boolean) => void;
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

const edgeId = (edge: KnowledgeEdge) =>
  `${edge.source}|${edge.target}|${edge.type}`;

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
  const focusRef = useRef<FocusState>({ nodeIds: null, edgeIds: null });
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
  const [activeLens, setActiveLens] = useState("all");
  const [activeDomains, toggleDomain, clearDomains] = useSetToggle<Domain>();
  const [activeKinds, toggleKind, clearKinds] = useSetToggle<NodeKind>();
  const [activeRelations, toggleRelation, clearRelations] =
    useSetToggle<RelationKind>();

  const nodeMap = useMemo(
    () => new Map(knowledgeNodes.map((nodeItem) => [nodeItem.id, nodeItem])),
    [],
  );

  const degreeMap = useMemo(() => {
    const map = new Map<string, number>();
    knowledgeNodes.forEach((item) => map.set(item.id, 0));
    knowledgeEdges.forEach((item) => {
      map.set(item.source, (map.get(item.source) ?? 0) + 1);
      map.set(item.target, (map.get(item.target) ?? 0) + 1);
    });
    return map;
  }, []);

  const domainCounts = useMemo(() => {
    const counts = new Map<Domain, number>();
    knowledgeNodes.forEach((item) =>
      counts.set(item.domain, (counts.get(item.domain) ?? 0) + 1),
    );
    return counts;
  }, []);

  const kindCounts = useMemo(() => {
    const counts = new Map<NodeKind, number>();
    knowledgeNodes.forEach((item) =>
      counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1),
    );
    return counts;
  }, []);

  const relationCounts = useMemo(() => {
    const counts = new Map<RelationKind, number>();
    knowledgeEdges.forEach((item) =>
      counts.set(item.type, (counts.get(item.type) ?? 0) + 1),
    );
    return counts;
  }, []);

  const selectedNode = selectedId ? nodeMap.get(selectedId) ?? null : null;

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
  }, [nodeMap, selectedId]);

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
  }, [degreeMap, query]);

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
    graphApiRef.current?.flyTo(id);
  }, []);

  useEffect(() => {
    const nodeIds = new Set<string>();
    const edgeIds = new Set<string>();
    const hasFilters =
      activeDomains.size > 0 ||
      activeKinds.size > 0 ||
      activeRelations.size > 0;

    if (selectedId) {
      nodeIds.add(selectedId);
      knowledgeEdges.forEach((item) => {
        if (item.source === selectedId || item.target === selectedId) {
          nodeIds.add(item.source);
          nodeIds.add(item.target);
          edgeIds.add(edgeId(item));
        }
      });
      focusRef.current = { nodeIds, edgeIds };
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
      focusRef.current = { nodeIds, edgeIds };
      return;
    }

    focusRef.current = { nodeIds: null, edgeIds: null };
  }, [activeDomains, activeKinds, activeRelations, selectedId]);

  useEffect(() => {
    graphApiRef.current?.setAutoRotate(autoRotate);
  }, [autoRotate]);

  useEffect(() => {
    graphApiRef.current?.setLabelsVisible(labelsVisible);
  }, [labelsVisible]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSelectedId(null);
        setSearchOpen(false);
        setSidebarOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const host = canvasHostRef.current;
    if (!host) return;

    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
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
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
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
    const animatedNodePositions = new Float32Array(nodeCount * 3);
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
      animatedNodePositions.set([x, y, z], index * 3);
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

        void main() {
          vColor = color;
          vBoost = boost;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          float breath = 1.0 + 0.10 * uBreath * sin(uTime * 0.9 + seed);
          gl_PointSize = size * breath * (420.0 / -mvPosition.z) * clamp(boost, 1.0, 1.58);
          vFade = max(0.16, 1.0 - smoothstep(uNear, uFar, -mvPosition.z));
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `
        varying vec3 vColor;
        varying float vFade;
        varying float vBoost;

        void main() {
          vec2 uv = gl_PointCoord - 0.5;
          float distanceFromCenter = length(uv) * 2.0;
          if (distanceFromCenter > 1.0) discard;
          float core = smoothstep(0.55, 0.0, distanceFromCenter);
          float halo = smoothstep(1.0, 0.22, distanceFromCenter) * 0.38;
          float alpha = (core + halo) * vFade * min(vBoost, 2.2);
          gl_FragColor = vec4(vColor * vBoost, alpha);
        }
      `,
    });
    const nodePoints = new THREE.Points(nodeGeometry, nodeMaterial);
    scene.add(nodePoints);

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

    const dustCount = 240;
    const dustPositions = new Float32Array(dustCount * 3);
    for (let index = 0; index < dustCount; index += 1) {
      const radius = graphRadius * (1.2 + random() * 3.2);
      const theta = random() * Math.PI * 2;
      const phi = Math.acos(2 * random() - 1);
      dustPositions[index * 3] = radius * Math.sin(phi) * Math.cos(theta);
      dustPositions[index * 3 + 1] = radius * Math.cos(phi);
      dustPositions[index * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta);
    }
    const dustGeometry = new THREE.BufferGeometry();
    dustGeometry.setAttribute(
      "position",
      new THREE.BufferAttribute(dustPositions, 3),
    );
    const dustMaterial = new THREE.PointsMaterial({
      color: 0xb9c7d8,
      size: 0.9,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const dust = new THREE.Points(dustGeometry, dustMaterial);
    scene.add(dust);

    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    composer.addPass(
      new UnrealBloomPass(
        new THREE.Vector2(host.clientWidth, Math.max(1, host.clientHeight)),
        0.92,
        0.72,
        0.045,
      ),
    );

    const labelLayer = document.createElement("div");
    labelLayer.className = "graph-label-layer";
    host.appendChild(labelLayer);
    const labels = simNodes
      .map((item, index) => {
        if (item.kind !== "thesis") return null;
        const element = document.createElement("button");
        element.type = "button";
        element.className = "graph-thesis-label";
        element.textContent = item.shortLabel;
        element.addEventListener("click", () => selectNode(item.id));
        labelLayer.appendChild(element);
        return { element, index, id: item.id };
      })
      .filter(
        (item): item is { element: HTMLButtonElement; index: number; id: string } =>
          item !== null,
      );

    const raycaster = new THREE.Raycaster();
    raycaster.params.Points!.threshold = graphRadius * 0.028;
    const pointer = new THREE.Vector2();
    let pointerDirty = false;
    let pointerDown: { x: number; y: number } | null = null;
    let hoveredId: string | null = null;
    let frame = 0;
    let lastTime = performance.now();
    let lastPulse = lastTime;

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
        const startedAt = performance.now();
        const duration = 780;
        const animateReset = () => {
          const progress = clamp(
            (performance.now() - startedAt) / duration,
            0,
            1,
          );
          const eased = 1 - Math.pow(1 - progress, 3);
          camera.position.lerpVectors(startCamera, initialCameraPosition, eased);
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
    };

    const projection = new THREE.Vector3();

    const animate = (now: number) => {
      frame = requestAnimationFrame(animate);
      const delta = Math.min((now - lastTime) / 1000, 0.05);
      lastTime = now;
      const time = now / 1000;
      nodeMaterial.uniforms.uTime.value = time;

      if (!reducedMotion) {
        for (let index = 0; index < nodeCount; index += 1) {
          const motionOffset = index * 7;
          const positionOffset = index * 3;
          const amplitude = nodeMotion[motionOffset + 6];
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
      for (let index = 0; index < nodeCount; index += 1) {
        const targetBoost = focus.nodeIds
          ? focus.nodeIds.has(simNodes[index].id)
            ? 1.72
            : 0.11
          : 1;
        if (!focus.nodeIds && nodeBoosts[index] > 1) {
          nodeBoosts[index] = 1 + (nodeBoosts[index] - 1) * Math.exp(-1.45 * delta);
        } else {
          nodeBoosts[index] +=
            (targetBoost - nodeBoosts[index]) * Math.min(1, 7 * delta);
        }
      }
      nodeGeometry.attributes.boost.needsUpdate = true;

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
          ? focus.edgeIds.has(id)
            ? 1
            : 0.045
          : 0.33;
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

      labels.forEach(({ element, index, id }) => {
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
        const x = (projection.x * 0.5 + 0.5) * host.clientWidth + 13;
        const y = (-projection.y * 0.5 + 0.5) * host.clientHeight - 8;
        element.style.transform = `translate3d(${x}px, ${y}px, 0)`;
        element.style.opacity = String(
          focus.nodeIds ? (focus.nodeIds.has(id) ? 0.96 : 0.12) : 0.88,
        );
      });

      controls.update();
      composer.render();
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
      controls.dispose();
      composer.dispose();
      nodeGeometry.dispose();
      nodeMaterial.dispose();
      edgeGeometry.dispose();
      edgeMaterial.dispose();
      dustGeometry.dispose();
      dustMaterial.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      graphApiRef.current = null;
    };
  }, [selectNode]);

  const clearFocus = () => {
    setSelectedId(null);
    setActiveLens("all");
    clearDomains();
    clearKinds();
    clearRelations();
  };

  const hoveredNode = hovered ? nodeMap.get(hovered.id) : null;
  const hasFocus =
    selectedId ||
    activeDomains.size > 0 ||
    activeKinds.size > 0 ||
    activeRelations.size > 0;

  return (
    <main className="atlas-shell">
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
              <p className="eyebrow">KNOWLEDGE GRAPH · DEMO 01</p>
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
              <i /> LIVE
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
                ["all", "전체 우주", "44개의 AI 개념"],
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
          <p>INTERACTIVE KNOWLEDGE CONSTELLATION</p>
          <h2>AI가 작동하는 구조를<br />관계로 탐색합니다.</h2>
          <span>개념과 시스템 사이를 연결한 선행 데모 데이터</span>
        </div>

        <div className="graph-controls" aria-label="그래프 화면 제어">
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

        <div className="stage-footer">
          <span>AI KNOWLEDGE PROTOTYPE</span>
          <i />
          <span>THREE.JS · FORCE 3D · GPU BLOOM</span>
          <strong>01</strong>
        </div>

        {hovered && hoveredNode && !selectedNode && (
          <div
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
