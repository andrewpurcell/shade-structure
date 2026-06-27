import { useState, useCallback, useEffect, Fragment } from "react";
import {
  type ShapeState,
  type Point,
  createInitialState,
  getAdjacentEmptyCells,
  addCell,
  removeCell,
} from "./shapeState";
import { buildShareUrl, loadStateFromUrl } from "./urlState";

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

interface StructureEntry {
  id: string;
  config: ShapeConfig;
  state: ShapeState;
}

function createStructureEntry(): StructureEntry {
  return {
    id: crypto.randomUUID(),
    config: { ...defaultConfig },
    state: createInitialState(),
  };
}

function getInitialAppState(): {
  structures: StructureEntry[];
  inventory: Inventory;
} {
  const fromUrl = loadStateFromUrl();
  if (fromUrl) {
    return {
      structures: fromUrl.structures.map((s) => ({
        id: crypto.randomUUID(),
        config: { ...s.config },
        state: s.state,
      })),
      inventory: fromUrl.inventory,
    };
  }
  return {
    structures: [createStructureEntry()],
    inventory: loadInventory(),
  };
}

interface PartsBreakdown {
  poles: Map<number, number>;
  connectors: Map<number, number>;
  footPlates: number;
  ratchetStraps: number;
  lagScrews: number;
  tarps: Map<string, { w: number; h: number; count: number }>;
}

function emptyPartsBreakdown(): PartsBreakdown {
  return {
    poles: new Map(),
    connectors: new Map(),
    footPlates: 0,
    ratchetStraps: 0,
    lagScrews: 0,
    tarps: new Map(),
  };
}

function computePartsBreakdown(
  config: ShapeConfig,
  state: ShapeState,
): PartsBreakdown {
  const gx = Math.max(1, config.gridSizeX);
  const gy = Math.max(1, config.gridSizeY);
  const { height, preferUniversalConnectors, prefer2CellTarps } = config;

  const breakdown = emptyPartsBreakdown();

  const cellKeys = [...state.cells];
  const cellSet = new Set(cellKeys);
  if (cellKeys.length > 0) {
    if (!prefer2CellTarps) {
      const key = `${gx},${gy}`;
      breakdown.tarps.set(key, { w: gx, h: gy, count: cellKeys.length });
    } else {
      const key = (c: number, r: number) => `${c},${r}`;
      const parse = (k: string): { c: number; r: number } => {
        const [c = 0, r = 0] = k.split(",").map(Number);
        return { c, r };
      };
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
        const sizeKey = `${lo},${hi}`;
        tarpBySize.set(sizeKey, (tarpBySize.get(sizeKey) ?? 0) + count);
      };
      addTarp(2 * gx, gy, horizontalPairs);
      addTarp(gx, 2 * gy, verticalPairs);
      addTarp(gx, gy, cellKeys.length - 2 * matchR.size);
      for (const [sizeKey, count] of tarpBySize) {
        const [w = 0, h = 0] = sizeKey.split(",").map(Number);
        breakdown.tarps.set(sizeKey, { w, h, count });
      }
    }
  }

  const SEGMENT_LENGTH = 10;
  const lengthCounts = new Map<number, number>();
  const poleCount = state.vertices.size;
  lengthCounts.set(height, (lengthCounts.get(height) ?? 0) + poleCount);
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

  let twoWayFromSegments = 0;
  for (const [len, count] of lengthCounts) {
    const full = Math.floor(len / SEGMENT_LENGTH);
    const remainder = len % SEGMENT_LENGTH;
    const piecesPerRun = full + (remainder > 0 ? 1 : 0);
    breakdown.poles.set(
      SEGMENT_LENGTH,
      (breakdown.poles.get(SEGMENT_LENGTH) ?? 0) + count * full,
    );
    if (remainder > 0) {
      breakdown.poles.set(
        remainder,
        (breakdown.poles.get(remainder) ?? 0) + count,
      );
    }
    twoWayFromSegments += count * (piecesPerRun - 1);
  }

  for (const vid of state.vertices.keys()) {
    const degree = [...state.edges].filter(
      (ek) => ek.startsWith(vid + "|") || ek.endsWith("|" + vid),
    ).length;
    const slots = preferUniversalConnectors ? 5 : degree + 1;
    breakdown.connectors.set(
      slots,
      (breakdown.connectors.get(slots) ?? 0) + 1,
    );
    breakdown.ratchetStraps += degree === 2 ? 2 : 1;
  }
  if (twoWayFromSegments > 0) {
    breakdown.connectors.set(
      2,
      (breakdown.connectors.get(2) ?? 0) + twoWayFromSegments,
    );
  }

  breakdown.footPlates = state.vertices.size;
  breakdown.lagScrews = breakdown.ratchetStraps;

  return breakdown;
}

function mergePartsBreakdowns(breakdowns: PartsBreakdown[]): PartsBreakdown {
  const merged = emptyPartsBreakdown();
  for (const b of breakdowns) {
    for (const [len, count] of b.poles) {
      merged.poles.set(len, (merged.poles.get(len) ?? 0) + count);
    }
    for (const [slots, count] of b.connectors) {
      merged.connectors.set(slots, (merged.connectors.get(slots) ?? 0) + count);
    }
    merged.footPlates += b.footPlates;
    merged.ratchetStraps += b.ratchetStraps;
    merged.lagScrews += b.lagScrews;
    for (const [key, entry] of b.tarps) {
      const existing = merged.tarps.get(key);
      if (existing) existing.count += entry.count;
      else merged.tarps.set(key, { ...entry });
    }
  }
  return merged;
}


interface PartEntry {
  key: string;
  label: string;
  need: number;
}

function partsBreakdownToEntries(breakdown: PartsBreakdown): PartEntry[] {
  const entries: PartEntry[] = [];
  const sortedLengths = [...breakdown.poles.entries()].sort(
    (a, b) => a[0] - b[0],
  );
  const sortedConnectorSlots = [...breakdown.connectors.entries()].sort(
    (a, b) => a[0] - b[0],
  );
  for (const [len, count] of sortedLengths) {
    if (count > 0) {
      entries.push({
        key: `pole:${len}`,
        label: `Pole (${len} ft)`,
        need: count,
      });
    }
  }
  for (const [slots, count] of sortedConnectorSlots) {
    entries.push({
      key: `connector:${slots}`,
      label: `Connector (${slots}-way)`,
      need: count,
    });
  }
  if (breakdown.footPlates > 0) {
    entries.push({
      key: "foot-plates",
      label: "Foot plates",
      need: breakdown.footPlates,
    });
  }
  if (breakdown.ratchetStraps > 0) {
    entries.push({
      key: "ratchet-straps",
      label: "Ratchet straps",
      need: breakdown.ratchetStraps,
    });
  }
  if (breakdown.lagScrews > 0) {
    entries.push({
      key: "lag-screws",
      label: "Lag screws",
      need: breakdown.lagScrews,
    });
  }
  const tarpEntries = [...breakdown.tarps.values()].sort(
    (a, b) => a.w - b.w || a.h - b.h,
  );
  for (const entry of tarpEntries) {
    entries.push({
      key: `tarp:${entry.w}x${entry.h}`,
      label: `Tarps (${entry.w} ft × ${entry.h} ft)`,
      need: entry.count,
    });
  }
  return entries;
}

function entriesToTsv(
  entries: PartEntry[],
  inventory?: Inventory,
): string {
  const rows: string[][] = inventory
    ? [["Part", "Need", "Have", "Short"]]
    : [["Part", "Need"]];

  for (const entry of entries) {
    if (inventory) {
      const have = inventory[entry.key] ?? 0;
      const short = Math.max(0, entry.need - have);
      rows.push([
        entry.label,
        String(entry.need),
        String(have),
        String(short),
      ]);
    } else {
      rows.push([entry.label, String(entry.need)]);
    }
  }

  return rows.map((row) => row.join("\t")).join("\n");
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function CopyListButton({
  text,
  disabled = false,
  className = "",
}: {
  text: string;
  disabled?: boolean;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={async () => {
        const ok = await copyText(text);
        if (!ok) window.prompt("Copy this list:", text);
        else {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 2000);
        }
      }}
      className={`shrink-0 text-[10px] text-stone-500 hover:text-stone-800 disabled:text-stone-300 disabled:hover:text-stone-300 ${className}`}
    >
      {copied ? "Copied!" : "Copy"}
    </button>
  );
}

const INVENTORY_STORAGE_KEY = "shade-structure-inventory";

type Inventory = Record<string, number>;

function loadInventory(): Inventory {
  try {
    const raw = localStorage.getItem(INVENTORY_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const result: Inventory = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "number" && value >= 0 && Number.isFinite(value)) {
        result[key] = Math.floor(value);
      }
    }
    return result;
  } catch {
    return {};
  }
}

function computeStructureDimensions(
  config: ShapeConfig,
  state: ShapeState,
): { width: number; height: number } | null {
  if (state.vertices.size === 0) return null;
  const gx = Math.max(1, config.gridSizeX);
  const gy = Math.max(1, config.gridSizeY);
  const xs = [...state.vertices.values()].map((p) => p.x);
  const ys = [...state.vertices.values()].map((p) => p.y);
  const width = (Math.max(...xs) - Math.min(...xs)) * gx;
  const height = (Math.max(...ys) - Math.min(...ys)) * gy;
  return { width, height };
}

function structureTitle(
  config: ShapeConfig,
  state: ShapeState,
  index: number,
): string {
  const dims = computeStructureDimensions(config, state);
  if (!dims) return `Structure ${index + 1}`;
  return `Structure ${dims.width}x${dims.height}`;
}

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

function PartsListRows({
  entries,
  inventory,
  onSetHave,
}: {
  entries: PartEntry[];
  inventory?: Inventory;
  onSetHave?: (key: string, have: number) => void;
}) {
  const withInventory = inventory !== undefined && onSetHave !== undefined;

  if (withInventory) {
    return (
      <div className="grid grid-cols-[minmax(0,1fr)_2.5rem_3rem_2.5rem] gap-x-3 text-xs text-stone-800">
        <div className="border-b border-stone-200 pb-1.5 text-[11px] font-medium text-stone-500">
          Part
        </div>
        <div className="border-b border-stone-200 pb-1.5 text-right text-[11px] font-medium text-stone-500">
          Need
        </div>
        <div className="border-b border-stone-200 pb-1.5 text-right text-[11px] font-medium text-stone-500">
          Have
        </div>
        <div className="border-b border-stone-200 pb-1.5 text-right text-[11px] font-medium text-stone-500">
          Short
        </div>
        {entries.map((entry) => {
          const have = inventory[entry.key] ?? 0;
          const short = Math.max(0, entry.need - have);
          return (
            <Fragment key={entry.key}>
              <div className="min-w-0 border-t border-stone-100 py-1.5 leading-snug">
                {entry.label}
              </div>
              <div className="border-t border-stone-100 py-1.5 text-right tabular-nums">
                {entry.need}
              </div>
              <div className="border-t border-stone-100 py-1.5">
                <input
                  type="number"
                  min={0}
                  inputMode="numeric"
                  value={inventory[entry.key] ?? ""}
                  placeholder="0"
                  onChange={(e) => {
                    const raw = e.target.value;
                    if (raw === "") {
                      onSetHave(entry.key, 0);
                      return;
                    }
                    const n = Math.max(0, Math.floor(Number(raw) || 0));
                    onSetHave(entry.key, n);
                  }}
                  className="inventory-input block w-full rounded border border-stone-300 px-1.5 py-0.5 text-right text-xs tabular-nums"
                />
              </div>
              <div
                className={`border-t border-stone-100 py-1.5 text-right tabular-nums ${
                  short > 0 ? "font-medium text-amber-800" : "text-stone-500"
                }`}
              >
                {short}
              </div>
            </Fragment>
          );
        })}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_2.5rem] gap-x-4 text-xs text-stone-800">
      <div className="border-b border-stone-200 pb-1.5 text-[11px] font-medium text-stone-500">
        Part
      </div>
      <div className="border-b border-stone-200 pb-1.5 text-right text-[11px] font-medium text-stone-500">
        Need
      </div>
      {entries.map((entry) => (
        <Fragment key={entry.key}>
          <div className="min-w-0 border-t border-stone-100 py-1.5 leading-snug">
            {entry.label}
          </div>
          <div className="border-t border-stone-100 py-1.5 text-right tabular-nums">
            {entry.need}
          </div>
        </Fragment>
      ))}
    </div>
  );
}

function PartsList({
  config,
  state,
  title = "Parts list",
  className = "",
}: {
  config: ShapeConfig;
  state: ShapeState;
  title?: string;
  className?: string;
}) {
  const entries = partsBreakdownToEntries(
    computePartsBreakdown(config, state),
  );
  const tsv = entriesToTsv(entries);

  return (
    <section
      className={`bg-white rounded-lg shadow border border-stone-200 p-2.5 h-fit shrink-0 ${className}`}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-stone-700">{title}</h3>
        <CopyListButton text={tsv} disabled={entries.length === 0} />
      </div>
      {entries.length > 0 ? (
        <PartsListRows entries={entries} />
      ) : (
        <div className="text-xs text-stone-500">No parts yet.</div>
      )}
    </section>
  );
}

function CombinedPartsList({
  structures,
  className = "",
  inventory,
  onSetHave,
  onClearInventory,
}: {
  structures: StructureEntry[];
  className?: string;
  inventory: Inventory;
  onSetHave: (key: string, have: number) => void;
  onClearInventory: () => void;
}) {
  const breakdown = mergePartsBreakdowns(
    structures.map((s) => computePartsBreakdown(s.config, s.state)),
  );
  const entries = partsBreakdownToEntries(breakdown);
  const hasInventory = Object.keys(inventory).length > 0;
  const tsv = entriesToTsv(entries, inventory);

  return (
    <section
      className={`bg-white rounded-lg shadow border border-stone-200 p-3 ${className}`}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-xs font-semibold text-stone-700">
          Combined parts list
        </h2>
        <div className="flex items-center gap-2">
          <CopyListButton text={tsv} disabled={entries.length === 0} />
          <button
            type="button"
            onClick={onClearInventory}
            disabled={!hasInventory}
            className="shrink-0 text-[10px] text-stone-500 hover:text-stone-800 disabled:text-stone-300 disabled:hover:text-stone-300"
          >
            Clear all
          </button>
        </div>
      </div>
      {entries.length > 0 ? (
        <PartsListRows
          entries={entries}
          inventory={inventory}
          onSetHave={onSetHave}
        />
      ) : (
        <div className="text-sm text-stone-500">No parts yet.</div>
      )}
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
    <aside className="w-full sm:w-40 shrink-0 bg-white rounded-lg shadow border border-stone-200 p-2.5 h-fit">
      <h2 className="text-xs font-semibold text-stone-700 mb-2">
        Configuration
      </h2>
      <div className="space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-[10px] text-stone-500 mb-0.5">
              Grid X
            </label>
            <input
              type="number"
              min={1}
              value={config.gridSizeX}
              onChange={(e) => set({ gridSizeX: Number(e.target.value) || 1 })}
              className="w-full rounded border border-stone-300 px-1.5 py-0.5 text-xs"
            />
          </div>
          <div>
            <label className="block text-[10px] text-stone-500 mb-0.5">
              Grid Y
            </label>
            <input
              type="number"
              min={1}
              value={config.gridSizeY}
              onChange={(e) => set({ gridSizeY: Number(e.target.value) || 1 })}
              className="w-full rounded border border-stone-300 px-1.5 py-0.5 text-xs"
            />
          </div>
        </div>
        <div>
          <label className="block text-[10px] text-stone-500 mb-0.5">
            Height
          </label>
          <input
            type="number"
            min={1}
            value={config.height}
            onChange={(e) => set({ height: Number(e.target.value) || 1 })}
            className="w-full rounded border border-stone-300 px-1.5 py-0.5 text-xs"
          />
        </div>
        <label className="flex items-start gap-1.5 cursor-pointer">
          <input
            type="checkbox"
            checked={config.preferUniversalConnectors}
            onChange={(e) =>
              set({ preferUniversalConnectors: e.target.checked })
            }
            className="mt-0.5 rounded border-stone-300 shrink-0"
          />
          <span className="text-[11px] leading-tight text-stone-700">
            Prefer universal connectors
          </span>
        </label>
        <label className="flex items-start gap-1.5 cursor-pointer">
          <input
            type="checkbox"
            checked={config.prefer2CellTarps}
            onChange={(e) => set({ prefer2CellTarps: e.target.checked })}
            className="mt-0.5 rounded border-stone-300 shrink-0"
          />
          <span className="text-[11px] leading-tight text-stone-700">
            Prefer 2-cell tarps
          </span>
        </label>
      </div>
    </aside>
  );
}

function StructureRow({
  index,
  entry,
  canRemove,
  onConfigChange,
  onAddCell,
  onRemoveCell,
  onRemoveRow,
}: {
  index: number;
  entry: StructureEntry;
  canRemove: boolean;
  onConfigChange: (config: ShapeConfig) => void;
  onAddCell: (c: number, r: number) => void;
  onRemoveCell: (c: number, r: number) => void;
  onRemoveRow: () => void;
}) {
  return (
    <section className="w-full">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-medium text-stone-700">
          {structureTitle(entry.config, entry.state, index)}
        </h2>
        {canRemove && (
          <button
            type="button"
            onClick={onRemoveRow}
            className="text-sm text-red-600 hover:text-red-800"
          >
            Remove
          </button>
        )}
      </div>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <div className="flex-1 min-w-0 flex flex-col items-center">
          <div className="bg-white rounded-lg shadow-lg border border-stone-200 overflow-hidden">
            <ShapeCanvas
              config={entry.config}
              state={entry.state}
              onAddCell={onAddCell}
              onRemoveCell={onRemoveCell}
            />
          </div>
        </div>
        <ConfigPanel config={entry.config} onChange={onConfigChange} />
        <PartsList
          config={entry.config}
          state={entry.state}
          className="w-full sm:w-56"
        />
      </div>
    </section>
  );
}

export default function App() {
  const [initialState] = useState(() => getInitialAppState());
  const [structures, setStructures] = useState<StructureEntry[]>(
    () => initialState.structures,
  );
  const [inventory, setInventory] = useState<Inventory>(
    () => initialState.inventory,
  );
  const [shareCopied, setShareCopied] = useState(false);

  useEffect(() => {
    localStorage.setItem(INVENTORY_STORAGE_KEY, JSON.stringify(inventory));
  }, [inventory]);

  const setHave = useCallback((key: string, have: number) => {
    setInventory((prev) => {
      const next = { ...prev };
      if (have <= 0) delete next[key];
      else next[key] = have;
      return next;
    });
  }, []);

  const clearInventory = useCallback(() => {
    setInventory({});
  }, []);

  const updateStructure = useCallback(
    (id: string, updater: (entry: StructureEntry) => StructureEntry) => {
      setStructures((prev) =>
        prev.map((entry) => (entry.id === id ? updater(entry) : entry)),
      );
    },
    [],
  );

  const addStructure = useCallback(() => {
    setStructures((prev) => [...prev, createStructureEntry()]);
  }, []);

  const removeStructure = useCallback((id: string) => {
    setStructures((prev) => {
      if (prev.length <= 1) return prev;
      return prev.filter((entry) => entry.id !== id);
    });
  }, []);

  const handleShare = useCallback(async () => {
    const url = buildShareUrl(structures, inventory);
    window.history.replaceState(null, "", url);
    try {
      await navigator.clipboard.writeText(url);
      setShareCopied(true);
      window.setTimeout(() => setShareCopied(false), 2000);
    } catch {
      window.prompt("Copy this link:", url);
    }
  }, [structures, inventory]);

  return (
    <main className="min-h-screen bg-stone-100 p-4 sm:p-8">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 lg:flex-row lg:items-start lg:gap-6">
        <aside className="hidden lg:block lg:sticky lg:top-8 lg:w-72 lg:shrink-0">
          <CombinedPartsList
            structures={structures}
            inventory={inventory}
            onSetHave={setHave}
            onClearInventory={clearInventory}
            className="shadow-lg max-h-[calc(100vh-4rem)] overflow-y-auto"
          />
        </aside>

        <div className="flex min-w-0 flex-1 flex-col items-center">
          <div className="mb-2 flex w-full items-center justify-center gap-3">
            <h1 className="text-2xl font-semibold text-stone-700">
              Shade Structure
            </h1>
            <button
              type="button"
              onClick={handleShare}
              className="rounded-lg border border-stone-300 bg-white px-3 py-1 text-sm font-medium text-stone-700 shadow-sm hover:bg-stone-50"
            >
              {shareCopied ? "Copied!" : "Share"}
            </button>
          </div>
          <p className="text-stone-500 text-sm mb-8 text-center">
            Click a ghost square to add; right‑click a filled square to remove.
          </p>

          <div className="flex w-full flex-col items-center gap-12">
            {structures.map((entry, index) => (
              <StructureRow
                key={entry.id}
                index={index}
                entry={entry}
                canRemove={structures.length > 1}
                onConfigChange={(config) =>
                  updateStructure(entry.id, (e) => ({ ...e, config }))
                }
                onAddCell={(c, r) =>
                  updateStructure(entry.id, (e) => ({
                    ...e,
                    state: addCell(e.state, c, r),
                  }))
                }
                onRemoveCell={(c, r) =>
                  updateStructure(entry.id, (e) => ({
                    ...e,
                    state: removeCell(e.state, c, r),
                  }))
                }
                onRemoveRow={() => removeStructure(entry.id)}
              />
            ))}

            <button
              type="button"
              onClick={addStructure}
              className="rounded-lg border border-stone-300 bg-white px-4 py-2 text-sm font-medium text-stone-700 shadow-sm hover:bg-stone-50"
            >
              Add structure
            </button>

            <CombinedPartsList
              structures={structures}
              inventory={inventory}
              onSetHave={setHave}
              onClearInventory={clearInventory}
              className="w-full max-w-4xl lg:hidden"
            />
          </div>
        </div>
      </div>
    </main>
  );
}
