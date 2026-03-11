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

export interface ShapeState {
  vertices: Map<string, Point>;
  edges: Set<string>;
  cells: Set<string>;
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

export function createInitialState(): ShapeState {
  const cells = new Set<string>(["0,0"]);
  const vertices = new Map<string, Point>();
  const edges = new Set<string>();
  addCellToMutable(vertices, edges, 0, 0);
  return { vertices, edges, cells };
}

function copyState(s: ShapeState): ShapeState {
  return {
    vertices: new Map(s.vertices),
    edges: new Set(s.edges),
    cells: new Set(s.cells),
  };
}

export function addCell(state: ShapeState, c: number, r: number): ShapeState {
  const key = `${c},${r}`;
  if (state.cells.has(key)) return state;
  const next = copyState(state);
  next.cells.add(key);
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
  return next;
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
      if (!state.cells.has(nkey)) out.add(nkey);
    }
  }
  return out;
}

export function gridToPixel(gx: number, gy: number, origin: Point): Point {
  return {
    x: origin.x + gx * CELL_SIZE,
    y: origin.y + gy * CELL_SIZE,
  };
}
