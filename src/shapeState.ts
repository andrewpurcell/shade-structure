export const CELL_SIZE = 10;
export const VERTEX_RADIUS = 5;

export type Point = { x: number; y: number };

export function vertexId(x: number, y: number): string {
  return `${x},${y}`;
}

function edgeKey(a: string, b: string): string {
  return [a, b].sort().join("|");
}

function cellCorners(c: number, r: number): [string, string, string, string] {
  return [
    vertexId(c, r),
    vertexId(c + 1, r),
    vertexId(c + 1, r + 1),
    vertexId(c, r + 1),
  ];
}

function cellEdges(c: number, r: number): string[] {
  const [v0, v1, v2, v3] = cellCorners(c, r);
  return [edgeKey(v0, v1), edgeKey(v1, v2), edgeKey(v2, v3), edgeKey(v3, v0)];
}

export type SideShadeType = "flat" | "angle";

export interface SideShade {
  c: number;
  r: number;
  attachC: number;
  attachR: number;
  type: SideShadeType;
}

export interface ShapeState {
  vertices: Map<string, Point>;
  edges: Set<string>;
  cells: Set<string>;
  sideShades: Map<string, SideShade>;
}

function addCellToMutable(
  vertices: Map<string, Point>,
  edges: Set<string>,
  c: number,
  r: number,
): void {
  const [v0, v1, v2, v3] = cellCorners(c, r);
  const points: [string, Point][] = [
    [v0, { x: c, y: r }],
    [v1, { x: c + 1, y: r }],
    [v2, { x: c + 1, y: r + 1 }],
    [v3, { x: c, y: r + 1 }],
  ];
  for (const [id, p] of points) vertices.set(id, p);
  for (const e of cellEdges(c, r)) edges.add(e);
}

function sideShadeKey(c: number, r: number): string {
  return `${c},${r}`;
}

export function createInitialState(): ShapeState {
  const cells = new Set<string>(["0,0"]);
  const vertices = new Map<string, Point>();
  const edges = new Set<string>();
  addCellToMutable(vertices, edges, 0, 0);
  return { vertices, edges, cells, sideShades: new Map() };
}

function copyState(s: ShapeState): ShapeState {
  return {
    vertices: new Map(s.vertices),
    edges: new Set(s.edges),
    cells: new Set(s.cells),
    sideShades: new Map(s.sideShades),
  };
}

export function addCell(state: ShapeState, c: number, r: number): ShapeState {
  const key = `${c},${r}`;
  if (state.cells.has(key)) return state;
  const next = copyState(state);
  next.cells.add(key);
  next.sideShades.delete(key);
  addCellToMutable(next.vertices, next.edges, c, r);
  return next;
}

function isEdgeUsedByAnyCell(edge: string, cells: Set<string>): boolean {
  for (const cell of cells) {
    const parts = cell.split(",");
    const c = Number(parts[0]);
    const r = Number(parts[1]);
    if (cellEdges(c, r).includes(edge)) return true;
  }
  return false;
}

export function removeCell(
  state: ShapeState,
  c: number,
  r: number,
): ShapeState {
  const key = `${c},${r}`;
  if (!state.cells.has(key)) return state;
  const next = copyState(state);
  next.cells.delete(key);
  const corners = cellCorners(c, r);
  for (const e of cellEdges(c, r)) {
    if (!isEdgeUsedByAnyCell(e, next.cells)) next.edges.delete(e);
  }
  for (const v of corners) {
    const stillUsed = [...next.edges].some(
      (ek) => ek.startsWith(v + "|") || ek.endsWith("|" + v),
    );
    if (!stillUsed) next.vertices.delete(v);
  }
  for (const side of [...next.sideShades.values()]) {
    if (side.attachC === c && side.attachR === r) {
      next.sideShades.delete(sideShadeKey(side.c, side.r));
    }
  }
  return next;
}

export function getShapeGridBounds(state: ShapeState): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  let minX = 0;
  let minY = 0;
  let maxX = 1;
  let maxY = 1;

  for (const key of state.cells) {
    const parts = key.split(",");
    const c = Number(parts[0]);
    const r = Number(parts[1]);
    minX = Math.min(minX, c);
    minY = Math.min(minY, r);
    maxX = Math.max(maxX, c + 1);
    maxY = Math.max(maxY, r + 1);
  }

  for (const side of state.sideShades.values()) {
    minX = Math.min(minX, side.c);
    minY = Math.min(minY, side.r);
    maxX = Math.max(maxX, side.c + 1);
    maxY = Math.max(maxY, side.r + 1);
  }

  return { minX, minY, maxX, maxY };
}

export function getAdjacentEmptyCells(state: ShapeState): Set<string> {
  const out = new Set<string>();
  const dirs: [number, number][] = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ];
  for (const cell of state.cells) {
    const parts = cell.split(",");
    const c = Number(parts[0]);
    const r = Number(parts[1]);
    for (const [dc, dr] of dirs) {
      const nc = c + dc;
      const nr = r + dr;
      const nkey = `${nc},${nr}`;
      if (!state.cells.has(nkey) && !state.sideShades.has(nkey)) out.add(nkey);
    }
  }
  return out;
}

const CARDINAL_DIRS: [number, number][] = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];

export function getAdjacentShadeNeighbors(
  state: ShapeState,
  c: number,
  r: number,
): { attachC: number; attachR: number }[] {
  const neighbors: { attachC: number; attachR: number }[] = [];
  for (const [dc, dr] of CARDINAL_DIRS) {
    const ac = c + dc;
    const ar = r + dr;
    if (state.cells.has(`${ac},${ar}`)) {
      neighbors.push({ attachC: ac, attachR: ar });
    }
  }
  return neighbors;
}

export function isSideWallEligible(
  state: ShapeState,
  c: number,
  r: number,
): boolean {
  return getAdjacentShadeNeighbors(state, c, r).length === 1;
}

export function cycleAdjacentSpot(
  state: ShapeState,
  c: number,
  r: number,
): ShapeState {
  const key = sideShadeKey(c, r);
  const side = state.sideShades.get(key);

  if (side) {
    if (side.type === "flat") return toggleSideShadeType(state, c, r);
    const cleared = removeSideShade(state, c, r);
    return addCell(cleared, c, r);
  }

  if (state.cells.has(key)) {
    if (!isSideWallEligible(state, c, r)) return state;
    const attach = getAdjacentShadeNeighbors(state, c, r)[0]!;
    const cleared = removeCell(state, c, r);
    return addSideShade(cleared, c, r, attach.attachC, attach.attachR);
  }

  return addCell(state, c, r);
}

export function addSideShade(
  state: ShapeState,
  c: number,
  r: number,
  attachC: number,
  attachR: number,
): ShapeState {
  const key = sideShadeKey(c, r);
  if (state.cells.has(key) || state.sideShades.has(key)) return state;
  if (!state.cells.has(`${attachC},${attachR}`)) return state;
  const dc = attachC - c;
  const dr = attachR - r;
  if (Math.abs(dc) + Math.abs(dr) !== 1) return state;
  const next = copyState(state);
  next.sideShades.set(key, { c, r, attachC, attachR, type: "flat" });
  return next;
}

export function removeSideShade(
  state: ShapeState,
  c: number,
  r: number,
): ShapeState {
  const key = sideShadeKey(c, r);
  if (!state.sideShades.has(key)) return state;
  const next = copyState(state);
  next.sideShades.delete(key);
  return next;
}

export function toggleSideShadeType(
  state: ShapeState,
  c: number,
  r: number,
): ShapeState {
  const key = sideShadeKey(c, r);
  const side = state.sideShades.get(key);
  if (!side) return state;
  const next = copyState(state);
  next.sideShades.set(key, {
    ...side,
    type: side.type === "flat" ? "angle" : "flat",
  });
  return next;
}

export function sideShadeEdgeLength(
  side: SideShade,
  gridSizeX: number,
  gridSizeY: number,
): number {
  const dc = side.attachC - side.c;
  return dc !== 0 ? gridSizeY : gridSizeX;
}

export function gridToPixel(gx: number, gy: number, origin: Point): Point {
  return {
    x: origin.x + gx * CELL_SIZE,
    y: origin.y + gy * CELL_SIZE,
  };
}
