import { useState, useCallback } from "react";
import {
  type ShapeState,
  type Point,
  createInitialState,
  getAdjacentEmptyCells,
  addCell,
  removeCell,
} from "./shapeState";

const DISPLAY_SIZE = 400; // canvas size in pixels (height config does not affect rendering)
const VERTEX_RADIUS_GRID = 0.08; // in grid units
const EDGE_STROKE_GRID = 0.04; // in grid units

export interface ShapeConfig {
  gridSizeX: number;
  gridSizeY: number;
  height: number;
  preferUniversalConnectors: boolean;
  prefer2CellTarps: boolean;
}

const defaultConfig: ShapeConfig = {
  gridSizeX: 10,
  gridSizeY: 10,
  height: 10,
  preferUniversalConnectors: false,
  prefer2CellTarps: true,
};

function ShapeCanvas({
  config,
  state,
  onAddCell,
  onRemoveCell,
}: {
  config: ShapeConfig;
  state: ShapeState;
  onAddCell: (c: number, r: number) => void;
  onRemoveCell: (c: number, r: number) => void;
}) {
  const allX = [...state.vertices.values()].map((p) => p.x);
  const allY = [...state.vertices.values()].map((p) => p.y);
  const minX = Math.min(0, ...allX);
  const maxX = Math.max(1, ...allX);
  const minY = Math.min(0, ...allY);
  const maxY = Math.max(1, ...allY);
  const padding = 1;
  const viewMinX = minX - padding;
  const viewMinY = minY - padding;
  const viewW = maxX - minX + 2 * padding;
  const viewH = maxY - minY + 2 * padding;

  const edges = [...state.edges]
    .map((ek) => {
      const parts = ek.split("|");
      const a = parts[0] ?? "";
      const b = parts[1] ?? "";
      const pa = state.vertices.get(a);
      const pb = state.vertices.get(b);
      if (!pa || !pb) return null;
      return { p1: pa, p2: pb };
    })
    .filter(Boolean) as { p1: Point; p2: Point }[];

  const vertexPoints = [...state.vertices.entries()].map(([id, p]) => ({
    id,
    ...p,
  }));

  const addCells = getAdjacentEmptyCells(state);
  const addRects = [...addCells].map((key) => {
    const parts = key.split(",");
    const c = Number(parts[0]);
    const r = Number(parts[1]);
    return { key, c, r };
  });

  const occupiedRects = [...state.cells].map((key) => {
    const parts = key.split(",");
    const c = Number(parts[0]);
    const r = Number(parts[1]);
    return { key, c, r };
  });

  const gx = Math.max(1, config.gridSizeX);
  const gy = Math.max(1, config.gridSizeY);
  const viewMinXS = viewMinX * gx;
  const viewMinYS = viewMinY * gy;
  const viewWS = viewW * gx;
  const viewHS = viewH * gy;
  const L = Math.max(viewWS, viewHS);
  const displayWidth = (DISPLAY_SIZE * viewWS) / L;
  const displayHeight = (DISPLAY_SIZE * viewHS) / L;
  const viewBoxScaled = `${viewMinXS} ${viewMinYS} ${viewWS} ${viewHS}`;

  return (
    <svg
      width={displayWidth}
      height={displayHeight}
      className="block"
      viewBox={viewBoxScaled}
      preserveAspectRatio="xMidYMid meet"
    >
      <g className="shape" transform={`scale(${gx}, ${gy})`}>
        {edges.map((e, i) => (
          <line
            key={i}
            x1={e.p1.x}
            y1={e.p1.y}
            x2={e.p2.x}
            y2={e.p2.y}
            className="edge"
            strokeWidth={EDGE_STROKE_GRID}
          />
        ))}
        {vertexPoints.map((v) => (
          <ellipse
            key={v.id}
            cx={v.x}
            cy={v.y}
            rx={VERTEX_RADIUS_GRID}
            ry={VERTEX_RADIUS_GRID * (gx / gy)}
            className="vertex"
          />
        ))}
        {addRects.map((rect) => (
          <rect
            key={rect.key}
            x={rect.c}
            y={rect.r}
            width={1}
            height={1}
            className="add-cell"
            onClick={() => onAddCell(rect.c, rect.r)}
          />
        ))}
        {occupiedRects.map((rect) => (
          <rect
            key={rect.key}
            x={rect.c}
            y={rect.r}
            width={1}
            height={1}
            className="occupied-cell"
            onContextMenu={(e) => {
              e.preventDefault();
              onRemoveCell(rect.c, rect.r);
            }}
          />
        ))}
      </g>
    </svg>
  );
}

function StateDebug({ state }: { state: ShapeState }) {
  const vertices = Object.fromEntries(
    [...state.vertices.entries()].map(([id, p]) => [id, { x: p.x, y: p.y }]),
  );
  const edges = [...state.edges];
  const cells = [...state.cells];
  return (
    <pre className="mt-8 w-full max-w-4xl text-xs font-mono text-stone-600 bg-stone-200 rounded-lg p-4 overflow-auto max-h-48">
      {JSON.stringify({ vertices, edges, cells }, null, 2)}
    </pre>
  );
}

function PartsList({
  config,
  state,
}: {
  config: ShapeConfig;
  state: ShapeState;
}) {
  const gx = Math.max(1, config.gridSizeX);
  const gy = Math.max(1, config.gridSizeY);
  const { height, preferUniversalConnectors, prefer2CellTarps } = config;

  // Tarps: cover active cells
  const cellKeys = [...state.cells];
  const cellSet = new Set(cellKeys);
  type TarpEntry = { w: number; h: number; count: number };
  const tarpEntries: TarpEntry[] = [];
  if (cellKeys.length > 0) {
    if (!prefer2CellTarps) {
      tarpEntries.push({ w: gx, h: gy, count: cellKeys.length });
    } else {
      const key = (c: number, r: number) => `${c},${r}`;
      const parse = (k: string): { c: number; r: number } => {
        const [c = 0, r = 0] = k.split(",").map(Number);
        return { c, r };
      };
      // Maximum bipartite matching: grid cells are bipartite by (c+r) % 2.
      // Match as many adjacent cell pairs as possible (any mix of horizontal/vertical).
      const leftCells = cellKeys.filter((k) => {
        const { c, r } = parse(k);
        return (c + r) % 2 === 0;
      });
      const adj = new Map<string, string[]>();
      for (const k of leftCells) {
        const { c, r } = parse(k);
        const neighbors: string[] = [];
        for (const [dc, dr] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const nk = key(c + dc, r + dr);
          if (cellSet.has(nk)) neighbors.push(nk);
        }
        adj.set(k, neighbors);
      }
      const matchR = new Map<string, string>();
      const dfs = (u: string, seen: Set<string>): boolean => {
        for (const v of adj.get(u) ?? []) {
          if (seen.has(v)) continue;
          seen.add(v);
          const matchedTo = matchR.get(v);
          if (matchedTo === undefined || dfs(matchedTo, seen)) {
            matchR.set(v, u);
            return true;
          }
        }
        return false;
      };
      for (const u of leftCells) {
        dfs(u, new Set());
      }
      // Classify each matched pair as horizontal or vertical; merge counts by canonical size (smaller × larger)
      let horizontalPairs = 0;
      let verticalPairs = 0;
      for (const [rightK, leftK] of matchR) {
        const pa = parse(leftK);
        const pb = parse(rightK);
        if (pa.r === pb.r) horizontalPairs++;
        else verticalPairs++;
      }
      const canonical = (a: number, b: number) =>
        [Math.min(a, b), Math.max(a, b)] as const;
      const tarpBySize = new Map<string, number>();
      const addTarp = (w: number, h: number, count: number) => {
        if (count <= 0) return;
        const [lo, hi] = canonical(w, h);
        const key = `${lo},${hi}`;
        tarpBySize.set(key, (tarpBySize.get(key) ?? 0) + count);
      };
      addTarp(2 * gx, gy, horizontalPairs);
      addTarp(gx, 2 * gy, verticalPairs);
      addTarp(gx, gy, cellKeys.length - 2 * matchR.size);
      for (const [key, count] of tarpBySize) {
        const [w = 0, h = 0] = key.split(",").map(Number);
        tarpEntries.push({ w, h, count });
      }
      tarpEntries.sort((a, b) => a.w - b.w || a.h - b.h);
    }
  }

  // Combined poles + edges by length (all in ft)
  const lengthCounts = new Map<number, number>();
  // Poles: one per vertex, length = height
  const poleCount = state.vertices.size;
  lengthCounts.set(height, (lengthCounts.get(height) ?? 0) + poleCount);
  // Edge lengths (respecting grid)
  for (const ek of state.edges) {
    const parts = ek.split("|");
    const a = parts[0] ?? "";
    const b = parts[1] ?? "";
    const pa = state.vertices.get(a);
    const pb = state.vertices.get(b);
    if (!pa || !pb) continue;
    const dx = Math.abs(pb.x - pa.x);
    const dy = Math.abs(pb.y - pa.y);
    const length = dx > 0 ? gx * dx : gy * dy;
    lengthCounts.set(length, (lengthCounts.get(length) ?? 0) + 1);
  }

  // Connectors: per vertex, (edge count + 1) unless universal then 5
  const connectorCounts = new Map<number, number>();
  let ratchetStraps = 0;
  for (const vid of state.vertices.keys()) {
    const degree = [...state.edges].filter(
      (ek) => ek.startsWith(vid + "|") || ek.endsWith("|" + vid),
    ).length;
    const slots = preferUniversalConnectors ? 5 : degree + 1;
    connectorCounts.set(slots, (connectorCounts.get(slots) ?? 0) + 1);
    ratchetStraps += degree === 2 ? 2 : 1;
  }

  const footPlates = state.vertices.size;
  const lagScrews = ratchetStraps;

  const sortedLengths = [...lengthCounts.entries()].sort((a, b) => a[0] - b[0]);
  const sortedConnectorSlots = [...connectorCounts.entries()].sort(
    (a, b) => a[0] - b[0],
  );

  const lines: string[] = [];
  for (const [len, count] of sortedLengths) {
    lines.push(`Poles (${len} ft): ${count}`);
  }
  for (const [slots, count] of sortedConnectorSlots) {
    lines.push(`Connector (${slots}-way): ${count}`);
  }
  lines.push(`Foot plates: ${footPlates}`);
  lines.push(`Ratchet straps: ${ratchetStraps}`);
  lines.push(`Lag screws: ${lagScrews}`);
  for (const entry of tarpEntries) {
    lines.push(`Tarps (${entry.w} ft × ${entry.h} ft): ${entry.count}`);
  }

  return (
    <section className="mt-8 w-full max-w-4xl bg-white rounded-lg shadow border border-stone-200 p-4">
      <h2 className="text-sm font-semibold text-stone-700 mb-3">Parts list</h2>
      <div className="text-sm text-stone-800 whitespace-pre-wrap break-all">
        {lines.map((line, i) => (
          <div key={i} className="leading-relaxed">
            {line}
          </div>
        ))}
      </div>
    </section>
  );
}

function ConfigPanel({
  config,
  onChange,
}: {
  config: ShapeConfig;
  onChange: (c: ShapeConfig) => void;
}) {
  const set = (patch: Partial<ShapeConfig>) =>
    onChange({ ...config, ...patch });
  return (
    <aside className="w-64 shrink-0 bg-white rounded-lg shadow border border-stone-200 p-4 h-fit">
      <h2 className="text-sm font-semibold text-stone-700 mb-3">
        Configuration
      </h2>
      <div className="space-y-3">
        <div>
          <label className="block text-xs text-stone-500 mb-1">
            Grid size X
          </label>
          <input
            type="number"
            min={1}
            value={config.gridSizeX}
            onChange={(e) => set({ gridSizeX: Number(e.target.value) || 1 })}
            className="w-full rounded border border-stone-300 px-2 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs text-stone-500 mb-1">
            Grid size Y
          </label>
          <input
            type="number"
            min={1}
            value={config.gridSizeY}
            onChange={(e) => set({ gridSizeY: Number(e.target.value) || 1 })}
            className="w-full rounded border border-stone-300 px-2 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs text-stone-500 mb-1">Height</label>
          <input
            type="number"
            min={1}
            value={config.height}
            onChange={(e) => set({ height: Number(e.target.value) || 1 })}
            className="w-full rounded border border-stone-300 px-2 py-1.5 text-sm"
          />
        </div>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={config.preferUniversalConnectors}
            onChange={(e) =>
              set({ preferUniversalConnectors: e.target.checked })
            }
            className="rounded border-stone-300"
          />
          <span className="text-sm text-stone-700">
            Prefer universal connectors
          </span>
        </label>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={config.prefer2CellTarps}
            onChange={(e) => set({ prefer2CellTarps: e.target.checked })}
            className="rounded border-stone-300"
          />
          <span className="text-sm text-stone-700">Prefer 2-cell tarps</span>
        </label>
      </div>
    </aside>
  );
}

export default function App() {
  const [config, setConfig] = useState<ShapeConfig>(defaultConfig);
  const [state, setState] = useState<ShapeState>(() => createInitialState());

  const handleAddCell = useCallback((c: number, r: number) => {
    setState((prev) => addCell(prev, c, r));
  }, []);
  const handleRemoveCell = useCallback((c: number, r: number) => {
    setState((prev) => removeCell(prev, c, r));
  }, []);

  return (
    <main className="min-h-screen bg-stone-100 flex flex-col items-center p-8">
      <div className="flex gap-8 w-full max-w-4xl">
        <div className="flex-1 min-w-0 flex flex-col items-center">
          <h1 className="text-2xl font-semibold text-stone-700 mb-4">
            Shade Structure
          </h1>
          <p className="text-stone-500 text-sm mb-4">
            Click a ghost square to add; right‑click a filled square to remove.
          </p>
          <div className="bg-white rounded-lg shadow-lg border border-stone-200 overflow-hidden">
            <ShapeCanvas
              config={config}
              state={state}
              onAddCell={handleAddCell}
              onRemoveCell={handleRemoveCell}
            />
          </div>
        </div>
        <ConfigPanel config={config} onChange={setConfig} />
      </div>
      <PartsList config={config} state={state} />
    </main>
  );
}
