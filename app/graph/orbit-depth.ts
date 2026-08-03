export type OrbitDepthKey = "core" | "depth-1" | "depth-2";

export type OrbitDepthDescriptor = {
  key: OrbitDepthKey;
  title: "CORE" | "DEPTH 01" | "DEPTH 02";
  detail: string;
  count: number;
};

export function orbitDepthDescriptors(
  centerLabel: string,
  oneHopCount: number,
  twoHopCount: number,
): OrbitDepthDescriptor[] {
  return [
    {
      key: "core",
      title: "CORE",
      detail: centerLabel || "SELECTED",
      count: 1,
    },
    {
      key: "depth-1",
      title: "DEPTH 01",
      detail: "DIRECT",
      count: Math.max(0, oneHopCount),
    },
    {
      key: "depth-2",
      title: "DEPTH 02",
      detail: "EXTENDED",
      count: Math.max(0, twoHopCount),
    },
  ];
}

export function orbitDepthAnchor(
  key: OrbitDepthKey,
  radii: readonly [number, number],
): [number, number, number] {
  if (key === "core") return [0, 0, 0];
  const radius = key === "depth-1" ? radii[0] : radii[1];
  const angle = key === "depth-1" ? 3.75 : 2.5;
  return [
    Math.cos(angle) * radius,
    Math.sin(angle) * radius * 0.48,
    Math.sin(angle * 2) * radius * 0.08,
  ];
}
