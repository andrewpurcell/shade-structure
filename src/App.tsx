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
}

const defaultConfig: ShapeConfig = {
  gridSizeX: 10,
  gridSizeY: 10,
  height: 10,
  preferUniversalConnectors: false,
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
      <g
        className="shape"
        transform={`scale(${gx}, ${gy})`}
      >
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
          <circle
            key={v.id}
            cx={v.x}
            cy={v.y}
            r={VERTEX_RADIUS_GRID}
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
  const { height, preferUniversalConnectors } = config;

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
  for (const vid of state.vertices.keys()) {
    const degree = [...state.edges].filter(
      (ek) => ek.startsWith(vid + "|") || ek.endsWith("|" + vid),
    ).length;
    const slots = preferUniversalConnectors ? 5 : degree + 1;
    connectorCounts.set(slots, (connectorCounts.get(slots) ?? 0) + 1);
  }

  const sortedLengths = [...lengthCounts.entries()].sort((a, b) => a[0] - b[0]);
  const sortedConnectorSlots = [...connectorCounts.entries()].sort(
    (a, b) => a[0] - b[0],
  );

  return (
    <section className="mt-8 w-full max-w-4xl bg-white rounded-lg shadow border border-stone-200 p-4">
      <h2 className="text-sm font-semibold text-stone-700 mb-3">Parts list</h2>
      <dl className="grid gap-2 text-sm">
        {sortedLengths.length > 0 && (
          <div>
            <dt className="text-stone-500 mb-1">Poles &amp; edges</dt>
            <dd className="flex flex-wrap gap-x-4 gap-y-1">
              {sortedLengths.map(([len, count]) => (
                <span key={len} className="font-medium text-stone-800">
                  {len} ft × {count}
                </span>
              ))}
            </dd>
          </div>
        )}
        {sortedConnectorSlots.length > 0 && (
          <div>
            <dt className="text-stone-500 mb-1">Connectors</dt>
            <dd className="flex flex-wrap gap-x-4 gap-y-1">
              {sortedConnectorSlots.map(([slots, count]) => (
                <span key={slots} className="font-medium text-stone-800">
                  {slots}-way × {count}
                </span>
              ))}
            </dd>
          </div>
        )}
      </dl>
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
      <StateDebug state={state} />
    </main>
  );
}
