declare module "d3-force-3d" {
  export interface ForceSimulation<Node> {
    force(name: string, force: unknown): ForceSimulation<Node>;
    stop(): ForceSimulation<Node>;
    tick(iterations?: number): ForceSimulation<Node>;
  }

  export interface LinkForce<Node, Link> {
    id(accessor: (node: Node) => string): LinkForce<Node, Link>;
    distance(value: number | ((link: Link) => number)): LinkForce<Node, Link>;
    strength(value: number | ((link: Link) => number)): LinkForce<Node, Link>;
  }

  export interface ManyBodyForce<Node> {
    strength(value: number | ((node: Node) => number)): ManyBodyForce<Node>;
  }

  export interface CollideForce<Node> {
    strength(value: number): CollideForce<Node>;
  }

  export function forceSimulation<Node>(
    nodes?: Node[],
    numDimensions?: number,
  ): ForceSimulation<Node>;
  export function forceLink<Node = unknown, Link = unknown>(
    links?: Link[],
  ): LinkForce<Node, Link>;
  export function forceManyBody<Node = unknown>(): ManyBodyForce<Node>;
  export function forceCenter(x?: number, y?: number, z?: number): unknown;
  export function forceCollide<Node = unknown>(
    radius?: number | ((node: Node) => number),
  ): CollideForce<Node>;
}
