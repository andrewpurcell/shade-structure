import { useState, useCallback, useEffect, useMemo, useId, Fragment } from "react";
import {
  type ShapeState,
  type Point,
  type SideShade,
  createInitialState,
  getAdjacentEmptyCells,
  getShapeGridBounds,
  removeCell,
  cycleAdjacentSpot,
  removeSideShade,
  sideShadeEdgeLength,
} from "./shapeState";
import { buildShareUrl, isCompressedUrlState, loadStateFromUrl, loadStateFromUrlSync } from "./urlState";

const DISPLAY_SIZE = 400; // canvas size in pixels (height config does not affect rendering)
const VERTEX_RADIUS_GRID = 0.08; // in grid units
const EDGE_STROKE_GRID = 0.04; // in grid units
const DEFAULT_FIGMA_SCALE = 10;

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

type TarpMode = "optimal" | "use-inventory";

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
  const fromUrl = loadStateFromUrlSync();
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
  bungieCords: number;
  tarps: Map<string, { w: number; h: number; count: number }>;
  sideTarps: Map<string, { w: number; h: number; count: number; angle: boolean }>;
}

function emptyPartsBreakdown(): PartsBreakdown {
  return {
    poles: new Map(),
    connectors: new Map(),
    footPlates: 0,
    ratchetStraps: 0,
    lagScrews: 0,
    bungieCords: 0,
    tarps: new Map(),
    sideTarps: new Map(),
  };
}

const GROMMET_SPACING_FT = 1.5;

function grommetsForEdge(feet: number): number {
  return Math.ceil(feet / GROMMET_SPACING_FT);
}

function bungieCordsForSideShade(
  side: SideShade,
  dimensions: { w: number; h: number },
): number {
  const { w, h } = dimensions;
  if (side.type === "angle") {
    return grommetsForEdge(w);
  }
  return grommetsForEdge(w) + 2 * grommetsForEdge(h);
}

function roundFeet(n: number): number {
  return Math.round(n * 10) / 10;
}

function sideTarpDimensions(
  side: SideShade,
  gx: number,
  gy: number,
  height: number,
): { w: number; h: number } {
  return {
    w: sideShadeEdgeLength(side, gx, gy),
    h: roundFeet(side.type === "angle" ? height * 1.4 : height),
  };
}

function parseCellKey(k: string): { c: number; r: number } {
  const [c = 0, r = 0] = k.split(",").map(Number);
  return { c, r };
}

function cellKey(c: number, r: number): string {
  return `${c},${r}`;
}

type TarpOverlayKind = "single" | "horizontal" | "vertical";

interface TarpOverlay {
  kind: TarpOverlayKind;
  cells: Array<{ c: number; r: number }>;
}

function tarpInventoryKey(w: number, h: number): string {
  const lo = Math.min(w, h);
  const hi = Math.max(w, h);
  return `tarp:${lo}x${hi}`;
}

function computeOptimalTarpOverlays(state: ShapeState): TarpOverlay[] {
  const cellKeys = [...state.cells];
  if (cellKeys.length === 0) return [];

  const cellSet = new Set(cellKeys);
  const leftCells = cellKeys.filter((k) => {
    const { c, r } = parseCellKey(k);
    return (c + r) % 2 === 0;
  });
  const adj = new Map<string, string[]>();
  for (const k of leftCells) {
    const { c, r } = parseCellKey(k);
    const neighbors: string[] = [];
    for (const [dc, dr] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nk = cellKey(c + dc, r + dr);
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

  const overlays: TarpOverlay[] = [];
  const paired = new Set<string>();
  for (const [rightK, leftK] of matchR) {
    paired.add(rightK);
    paired.add(leftK);
    const pa = parseCellKey(leftK);
    const pb = parseCellKey(rightK);
    overlays.push({
      kind: pa.r === pb.r ? "horizontal" : "vertical",
      cells: [pa, pb],
    });
  }
  for (const k of cellKeys) {
    if (!paired.has(k)) {
      overlays.push({ kind: "single", cells: [parseCellKey(k)] });
    }
  }
  return overlays;
}

function splitPairsUsingInventory(
  overlays: TarpOverlay[],
  gx: number,
  gy: number,
  remainingSingles: Map<string, number>,
): TarpOverlay[] {
  const key = tarpInventoryKey(gx, gy);
  const result: TarpOverlay[] = [];
  for (const overlay of overlays) {
    if (overlay.kind === "single") {
      result.push(overlay);
      continue;
    }
    const available = remainingSingles.get(key) ?? 0;
    if (available >= 2) {
      remainingSingles.set(key, available - 2);
      for (const cell of overlay.cells) {
        result.push({ kind: "single", cells: [cell] });
      }
    } else {
      result.push(overlay);
    }
  }
  return result;
}

function computeTarpOverlays(
  config: ShapeConfig,
  state: ShapeState,
  tarpMode: TarpMode,
  remainingSingles?: Map<string, number>,
): TarpOverlay[] {
  const cellKeys = [...state.cells];
  if (cellKeys.length === 0) return [];

  const optimal = computeOptimalTarpOverlays(state);
  if (tarpMode === "optimal" || !remainingSingles) return optimal;

  const gx = Math.max(1, config.gridSizeX);
  const gy = Math.max(1, config.gridSizeY);
  return splitPairsUsingInventory(optimal, gx, gy, remainingSingles);
}

function tarpOverlayDimensions(
  overlay: TarpOverlay,
  gx: number,
  gy: number,
): { w: number; h: number } {
  if (overlay.kind === "horizontal") return { w: 2 * gx, h: gy };
  if (overlay.kind === "vertical") return { w: gx, h: 2 * gy };
  return { w: gx, h: gy };
}

function computePartsBreakdown(
  config: ShapeConfig,
  state: ShapeState,
  tarpMode: TarpMode,
  remainingSingles?: Map<string, number>,
): PartsBreakdown {
  const gx = Math.max(1, config.gridSizeX);
  const gy = Math.max(1, config.gridSizeY);
  const { height, preferUniversalConnectors } = config;

  const breakdown = emptyPartsBreakdown();

  const overlays = computeTarpOverlays(
    config,
    state,
    tarpMode,
    remainingSingles,
  );
  if (overlays.length > 0) {
    const canonical = (a: number, b: number) =>
      [Math.min(a, b), Math.max(a, b)] as const;
    const tarpBySize = new Map<string, number>();
    for (const overlay of overlays) {
      const { w, h } = tarpOverlayDimensions(overlay, gx, gy);
      const [lo, hi] = canonical(w, h);
      const sizeKey = `${lo},${hi}`;
      tarpBySize.set(sizeKey, (tarpBySize.get(sizeKey) ?? 0) + 1);
    }
    for (const [sizeKey, count] of tarpBySize) {
      const [w = 0, h = 0] = sizeKey.split(",").map(Number);
      breakdown.tarps.set(sizeKey, { w, h, count });
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

  for (const side of state.sideShades.values()) {
    const { w, h } = sideTarpDimensions(side, gx, gy, height);
    const sizeKey = `${side.type === "angle" ? "a" : "f"}:${w},${h}`;
    const existing = breakdown.sideTarps.get(sizeKey);
    if (existing) existing.count++;
    else
      breakdown.sideTarps.set(sizeKey, {
        w,
        h,
        count: 1,
        angle: side.type === "angle",
      });
    breakdown.bungieCords += bungieCordsForSideShade(side, { w, h });
  }

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
    merged.bungieCords += b.bungieCords;
    for (const [key, entry] of b.tarps) {
      const existing = merged.tarps.get(key);
      if (existing) existing.count += entry.count;
      else merged.tarps.set(key, { ...entry });
    }
    for (const [key, entry] of b.sideTarps) {
      const existing = merged.sideTarps.get(key);
      if (existing) existing.count += entry.count;
      else merged.sideTarps.set(key, { ...entry });
    }
  }
  return merged;
}

function inventorySinglesBudget(inventory: Inventory): Map<string, number> {
  const budget = new Map<string, number>();
  for (const [key, count] of Object.entries(inventory)) {
    if (key.startsWith("tarp:") && count > 0) {
      budget.set(key, count);
    }
  }
  return budget;
}

function computeCombinedPartsBreakdown(
  structures: StructureEntry[],
  tarpMode: TarpMode,
  inventory: Inventory,
): PartsBreakdown {
  const remainingSingles =
    tarpMode === "use-inventory"
      ? inventorySinglesBudget(inventory)
      : undefined;
  const breakdowns = structures.map((s) =>
    computePartsBreakdown(
      s.config,
      s.state,
      tarpMode,
      remainingSingles,
    ),
  );
  return mergePartsBreakdowns(breakdowns);
}

function computeStructureBreakdowns(
  structures: StructureEntry[],
  tarpMode: TarpMode,
  inventory: Inventory,
): PartsBreakdown[] {
  const remainingSingles =
    tarpMode === "use-inventory"
      ? inventorySinglesBudget(inventory)
      : undefined;
  return structures.map((s) =>
    computePartsBreakdown(s.config, s.state, tarpMode, remainingSingles),
  );
}

function computeTarpOverlaysForStructure(
  structures: StructureEntry[],
  structureIndex: number,
  tarpMode: TarpMode,
  inventory: Inventory,
): TarpOverlay[] {
  const remainingSingles =
    tarpMode === "use-inventory"
      ? inventorySinglesBudget(inventory)
      : undefined;
  for (let i = 0; i < structureIndex; i++) {
    const s = structures[i]!;
    computeTarpOverlays(s.config, s.state, tarpMode, remainingSingles);
  }
  const entry = structures[structureIndex]!;
  return computeTarpOverlays(
    entry.config,
    entry.state,
    tarpMode,
    remainingSingles,
  );
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
  if (breakdown.bungieCords > 0) {
    entries.push({
      key: "bungie-cords",
      label: "Bungee cords",
      need: breakdown.bungieCords,
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
  const sideTarpEntries = [...breakdown.sideTarps.values()].sort(
    (a, b) => a.w - b.w || a.h - b.h || Number(a.angle) - Number(b.angle),
  );
  for (const entry of sideTarpEntries) {
    const kind = entry.angle ? "45°" : "flat";
    entries.push({
      key: `side-tarp:${entry.angle ? "angle" : "flat"}:${entry.w}x${entry.h}`,
      label: `Side tarps ${kind} (${entry.w} ft × ${entry.h} ft)`,
      need: entry.count,
    });
  }
  return entries;
}

interface InventoryShortInfo {
  short: number;
  coveredByLargerConnectors: boolean;
}

function canCoverWithLargerConnector(
  largerSlots: number,
  neededSlots: number,
): boolean {
  if (largerSlots <= neededSlots) return false;
  // 3-way connectors cannot substitute for 2-way; 4- and 5-way can.
  if (neededSlots === 2 && largerSlots === 3) return false;
  return true;
}

function computeInventoryShorts(
  entries: PartEntry[],
  inventory: Inventory,
): Map<string, InventoryShortInfo> {
  const result = new Map<string, InventoryShortInfo>();
  const connectorEntries = entries.filter((e) =>
    e.key.startsWith("connector:"),
  );
  const connectorSizes = connectorEntries
    .map((e) => Number(e.key.slice("connector:".length)))
    .sort((a, b) => a - b);

  const surplusBySize = new Map<number, number>();
  const connectorShorts = new Map<string, InventoryShortInfo>();
  for (let i = connectorSizes.length - 1; i >= 0; i--) {
    const size = connectorSizes[i]!;
    const key = `connector:${size}`;
    const entry = connectorEntries.find((e) => e.key === key);
    if (!entry) continue;
    const have = inventory[key] ?? 0;
    const rawShort = Math.max(0, entry.need - have);

    let remainingNeed = Math.max(0, entry.need - have);
    for (let j = connectorSizes.length - 1; j > i; j--) {
      const largerSize = connectorSizes[j]!;
      if (!canCoverWithLargerConnector(largerSize, size)) continue;
      const available = surplusBySize.get(largerSize) ?? 0;
      const used = Math.min(available, remainingNeed);
      if (used > 0) {
        surplusBySize.set(largerSize, available - used);
        remainingNeed -= used;
      }
    }

    const short = remainingNeed;
    surplusBySize.set(size, Math.max(0, have - entry.need));
    connectorShorts.set(key, {
      short,
      coveredByLargerConnectors: rawShort > 0 && short === 0,
    });
  }

  for (const entry of entries) {
    const connectorInfo = connectorShorts.get(entry.key);
    if (connectorInfo) {
      result.set(entry.key, connectorInfo);
      continue;
    }
    const have = inventory[entry.key] ?? 0;
    result.set(entry.key, {
      short: Math.max(0, entry.need - have),
      coveredByLargerConnectors: false,
    });
  }
  return result;
}

function entriesToTsv(
  entries: PartEntry[],
  inventory?: Inventory,
): string {
  const rows: string[][] = inventory
    ? [["Part", "Need", "Have", "Short"]]
    : [["Part", "Need"]];
  const shorts = inventory ? computeInventoryShorts(entries, inventory) : null;

  for (const entry of entries) {
    if (inventory) {
      const have = inventory[entry.key] ?? 0;
      const short = shorts!.get(entry.key)?.short ?? Math.max(0, entry.need - have);
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

function HintTooltip({ label }: { label: string }) {
  return (
    <span className="group relative ml-0.5 inline-block text-stone-400">
      *
      <span
        role="tooltip"
        className="pointer-events-none absolute right-[calc(100%+6px)] top-1/2 z-50 w-max max-w-[11rem] -translate-y-1/2 rounded bg-stone-800 px-2 py-1 text-right text-[10px] font-normal leading-snug text-white opacity-0 shadow-sm transition-opacity duration-150 group-hover:opacity-100"
      >
        {label}
      </span>
    </span>
  );
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
const SETTINGS_STORAGE_KEY = "shade-structure-settings";

type Inventory = Record<string, number>;

interface AppSettings {
  figmaScale: number;
  showTarpOverlay: boolean;
  tarpMode: TarpMode;
}

const defaultSettings: AppSettings = {
  figmaScale: DEFAULT_FIGMA_SCALE,
  showTarpOverlay: false,
  tarpMode: "optimal",
};

function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return { ...defaultSettings };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ...defaultSettings };
    }
    const record = parsed as {
      figmaScale?: unknown;
      showTarpOverlay?: unknown;
      tarpMode?: unknown;
    };
    const figmaScale = record.figmaScale;
    const showTarpOverlay = record.showTarpOverlay;
    const tarpMode = record.tarpMode;
    return {
      figmaScale:
        typeof figmaScale === "number" &&
        Number.isFinite(figmaScale) &&
        figmaScale > 0
          ? figmaScale
          : DEFAULT_FIGMA_SCALE,
      showTarpOverlay:
        typeof showTarpOverlay === "boolean" ? showTarpOverlay : false,
      tarpMode:
        tarpMode === "use-inventory" || tarpMode === "optimal"
          ? tarpMode
          : "optimal",
    };
  } catch {
    return { ...defaultSettings };
  }
}

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
  return {
    width: (Math.max(...xs) - Math.min(...xs)) * gx,
    height: (Math.max(...ys) - Math.min(...ys)) * gy,
  };
}

function extendBoundsForAngledSide(
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  side: SideShade,
): void {
  const dc = side.attachC - side.c;
  const dr = side.attachR - side.r;
  const { c, r } = side;

  // 45° walls are half-cell triangles: full extent along the attachment edge,
  // half a cell outward perpendicular to the structure face.
  if (dc !== 0) {
    bounds.minY = Math.min(bounds.minY, r);
    bounds.maxY = Math.max(bounds.maxY, r + 1);
    if (dc === 1) {
      bounds.minX = Math.min(bounds.minX, c + 0.5);
    } else {
      bounds.maxX = Math.max(bounds.maxX, c + 0.5);
    }
  } else {
    bounds.minX = Math.min(bounds.minX, c);
    bounds.maxX = Math.max(bounds.maxX, c + 1);
    if (dr === 1) {
      bounds.minY = Math.min(bounds.minY, r + 0.5);
    } else {
      bounds.maxY = Math.max(bounds.maxY, r + 0.5);
    }
  }
}

function computeFullDimensionsWithAngledSideWalls(
  config: ShapeConfig,
  state: ShapeState,
): { width: number; height: number } | null {
  const angled = [...state.sideShades.values()].filter(
    (side) => side.type === "angle",
  );
  if (angled.length === 0) return null;

  const gx = Math.max(1, config.gridSizeX);
  const gy = Math.max(1, config.gridSizeY);
  const bounds = {
    minX: Infinity,
    minY: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
  };

  const includeCell = (c: number, r: number) => {
    bounds.minX = Math.min(bounds.minX, c);
    bounds.minY = Math.min(bounds.minY, r);
    bounds.maxX = Math.max(bounds.maxX, c + 1);
    bounds.maxY = Math.max(bounds.maxY, r + 1);
  };

  for (const key of state.cells) {
    const parts = key.split(",");
    includeCell(Number(parts[0]), Number(parts[1]));
  }
  for (const side of angled) {
    extendBoundsForAngledSide(bounds, side);
  }

  if (!Number.isFinite(bounds.minX)) return null;

  return {
    width: (bounds.maxX - bounds.minX) * gx,
    height: (bounds.maxY - bounds.minY) * gy,
  };
}

function structureTitle(
  config: ShapeConfig,
  state: ShapeState,
  index: number,
): string {
  const dims = computeStructureDimensions(config, state);
  if (!dims) return `Structure ${index + 1}`;
  const base = `Structure ${dims.width}x${dims.height}`;
  const full = computeFullDimensionsWithAngledSideWalls(config, state);
  if (
    !full ||
    (full.width === dims.width && full.height === dims.height)
  ) {
    return base;
  }
  return `${base} (${full.width}x${full.height} with angle walls)`;
}

function sideShadePolygonPoints(side: SideShade): string {
  const { c, r, attachC, attachR, type } = side;
  const dc = attachC - c;
  const dr = attachR - r;
  const inset = 0.18;

  if (type === "flat") {
    if (dc === 1) {
      return `${c + 1 - inset},${r} ${c + 1},${r} ${c + 1},${r + 1} ${c + 1 - inset},${r + 1}`;
    }
    if (dc === -1) {
      return `${c + inset},${r} ${c},${r} ${c},${r + 1} ${c + inset},${r + 1}`;
    }
    if (dr === 1) {
      return `${c},${r + 1 - inset} ${c},${r + 1} ${c + 1},${r + 1} ${c + 1},${r + 1 - inset}`;
    }
    return `${c},${r + inset} ${c},${r} ${c + 1},${r} ${c + 1},${r + inset}`;
  }

  // Half-cell right triangle: attachment edge + corner farthest from structure.
  if (dc === 1) {
    return `${c + 1},${r} ${c},${r + 1} ${c + 1},${r + 1}`;
  }
  if (dc === -1) {
    return `${c},${r} ${c + 1},${r + 1} ${c},${r + 1}`;
  }
  if (dr === 1) {
    return `${c},${r + 1} ${c},${r} ${c + 1},${r + 1}`;
  }
  return `${c},${r} ${c + 1},${r + 1} ${c + 1},${r}`;
}

function buildExportSvg(
  config: ShapeConfig,
  state: ShapeState,
  figmaScale: number,
): string {
  const { minX, minY, maxX, maxY } = getShapeGridBounds(state);
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

  const vertexPoints = [...state.vertices.values()];
  const occupiedRects = [...state.cells].map((key) => {
    const parts = key.split(",");
    return { c: Number(parts[0]), r: Number(parts[1]) };
  });
  const sideShadeItems = [...state.sideShades.values()];

  const gx = Math.max(1, config.gridSizeX);
  const gy = Math.max(1, config.gridSizeY);
  const viewMinXS = viewMinX * gx;
  const viewMinYS = viewMinY * gy;
  const viewWS = viewW * gx;
  const viewHS = viewH * gy;
  const exportGx = gx * figmaScale;
  const exportGy = gy * figmaScale;
  const exportViewMinX = viewMinXS * figmaScale;
  const exportViewMinY = viewMinYS * figmaScale;
  const exportViewW = viewWS * figmaScale;
  const exportViewH = viewHS * figmaScale;

  const cellRects = occupiedRects
    .map(
      ({ c, r }) =>
        `<rect x="${c}" y="${r}" width="1" height="1" fill="rgba(120,113,108,0.12)" stroke="none"/>`,
    )
    .join("\n    ");

  const sideShades = sideShadeItems
    .map((side) => {
      const isFlat = side.type === "flat";
      const fill = isFlat
        ? "rgba(14,116,144,0.45)"
        : "rgba(180,83,9,0.45)";
      const stroke = isFlat
        ? "rgba(14,116,144,0.85)"
        : "rgba(180,83,9,0.85)";
      return `<polygon points="${sideShadePolygonPoints(side)}" fill="${fill}" stroke="${stroke}" stroke-width="0.035"/>`;
    })
    .join("\n    ");

  const edgeLines = edges
    .map(
      (e) =>
        `<line x1="${e.p1.x}" y1="${e.p1.y}" x2="${e.p2.x}" y2="${e.p2.y}" stroke="#444444" stroke-width="${EDGE_STROKE_GRID}" stroke-linecap="round"/>`,
    )
    .join("\n    ");

  const vertexEllipses = vertexPoints
    .map(
      (v) =>
        `<ellipse cx="${v.x}" cy="${v.y}" rx="${VERTEX_RADIUS_GRID}" ry="${VERTEX_RADIUS_GRID * (gx / gy)}" fill="#222222"/>`,
    )
    .join("\n    ");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="${exportViewMinX} ${exportViewMinY} ${exportViewW} ${exportViewH}" width="${exportViewW}" height="${exportViewH}">
  <g transform="scale(${exportGx}, ${exportGy})">
    ${cellRects}
    ${sideShades}
    ${edgeLines}
    ${vertexEllipses}
  </g>
</svg>`;
}

function downloadSvg(svg: string, filename: string): void {
  const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function ExportSvgButtons({
  config,
  state,
  index,
  figmaScale,
}: {
  config: ShapeConfig;
  state: ShapeState;
  index: number;
  figmaScale: number;
}) {
  const [copied, setCopied] = useState(false);
  const svg = buildExportSvg(config, state, figmaScale);
  const dims = computeStructureDimensions(config, state);
  const baseName = dims
    ? `structure-${dims.width}x${dims.height}`
    : `structure-${index + 1}`;

  return (
    <div className="flex flex-wrap items-center justify-center gap-2">
      <button
        type="button"
        onClick={async () => {
          const ok = await copyText(svg);
          if (!ok) window.prompt("Copy this SVG:", svg);
          else {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 2000);
          }
        }}
        className="rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-sm font-medium text-stone-700 shadow-sm hover:bg-stone-50"
      >
        {copied ? "Copied!" : "Copy SVG"}
      </button>
      <button
        type="button"
        onClick={() => downloadSvg(svg, `${baseName}.svg`)}
        className="rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-sm font-medium text-stone-700 shadow-sm hover:bg-stone-50"
      >
        Download SVG
      </button>
    </div>
  );
}

function ShapeCanvas({
  config,
  state,
  showTarpOverlay,
  tarpOverlays,
  onCycleAdjacentSpot,
  onRemoveCell,
  onRemoveSideShade,
}: {
  config: ShapeConfig;
  state: ShapeState;
  showTarpOverlay: boolean;
  tarpOverlays: TarpOverlay[];
  onCycleAdjacentSpot: (c: number, r: number) => void;
  onRemoveCell: (c: number, r: number) => void;
  onRemoveSideShade: (c: number, r: number) => void;
}) {
  const { minX, minY, maxX, maxY } = getShapeGridBounds(state);
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

  const sideShadeItems = [...state.sideShades.values()].map((side) => ({
    key: `${side.c},${side.r}`,
    side,
  }));

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
  const visibleOverlays = showTarpOverlay ? tarpOverlays : [];

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
            onClick={() => onCycleAdjacentSpot(rect.c, rect.r)}
          />
        ))}
        {sideShadeItems.map(({ key, side }) => (
          <g
            key={key}
            className="side-shade"
            onClick={() => onCycleAdjacentSpot(side.c, side.r)}
            onContextMenu={(e) => {
              e.preventDefault();
              onRemoveSideShade(side.c, side.r);
            }}
          >
            <rect
              x={side.c}
              y={side.r}
              width={1}
              height={1}
              className="side-shade-hit"
            />
            <polygon
              points={sideShadePolygonPoints(side)}
              className={
                side.type === "flat" ? "side-shade-flat" : "side-shade-angle"
              }
            />
          </g>
        ))}
        {occupiedRects.map((rect) => (
          <rect
            key={rect.key}
            x={rect.c}
            y={rect.r}
            width={1}
            height={1}
            className="occupied-cell"
            onClick={() => onCycleAdjacentSpot(rect.c, rect.r)}
            onContextMenu={(e) => {
              e.preventDefault();
              onRemoveCell(rect.c, rect.r);
            }}
          />
        ))}
        {visibleOverlays.map((overlay, i) => {
          const cs = overlay.cells.map((cell) => cell.c);
          const rs = overlay.cells.map((cell) => cell.r);
          const x = Math.min(...cs);
          const y = Math.min(...rs);
          const w = Math.max(...cs) - x + 1;
          const h = Math.max(...rs) - y + 1;
          const dims = tarpOverlayDimensions(overlay, gx, gy);
          return (
            <g key={i} className="tarp-overlay" pointerEvents="none">
              <rect
                x={x}
                y={y}
                width={w}
                height={h}
                className={`tarp-overlay-fill tarp-overlay-${overlay.kind}`}
              />
              <text
                x={x + w / 2}
                y={y + h / 2}
                className="tarp-overlay-label"
                textAnchor="middle"
                dominantBaseline="central"
              >
                {dims.w}×{dims.h}
              </text>
            </g>
          );
        })}
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
    const shorts = computeInventoryShorts(entries, inventory);
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
          const { short, coveredByLargerConnectors } = shorts.get(entry.key) ?? {
            short: Math.max(0, entry.need - (inventory[entry.key] ?? 0)),
            coveredByLargerConnectors: false,
          };
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
                className={`relative overflow-visible border-t border-stone-100 py-1.5 text-right tabular-nums ${
                  short > 0 ? "font-medium text-amber-800" : "text-stone-500"
                }`}
              >
                {short}
                {coveredByLargerConnectors && (
                  <HintTooltip label="Enough larger connectors on hand to cover this shortfall" />
                )}
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
  breakdown,
  title = "Parts list",
  className = "",
}: {
  breakdown: PartsBreakdown;
  title?: string;
  className?: string;
}) {
  const entries = partsBreakdownToEntries(breakdown);
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

function CalculationsExplanation({ className = "" }: { className?: string }) {
  return (
    <details
      className={`rounded-lg border border-stone-200 bg-white p-3 shadow ${className}`}
    >
      <summary className="cursor-pointer list-none text-xs font-semibold text-stone-700 [&::-webkit-details-marker]:hidden">
        How parts are calculated
      </summary>
      <dl className="mt-3 space-y-3 text-[11px] leading-snug text-stone-600">
        <div>
          <dt className="font-medium text-stone-700">Poles</dt>
          <dd className="mt-0.5">
            One vertical pole per corner post, sized to structure height. Each
            horizontal or vertical frame edge is measured in feet (grid spacing ×
            grid units) and covered with 10 ft segments, plus one cut piece when
            the length is not an exact multiple of 10 ft.
          </dd>
        </div>
        <div>
          <dt className="font-medium text-stone-700">Connectors</dt>
          <dd className="mt-0.5">
            One connector at each post: a 5-way universal connector when that
            option is enabled, otherwise a connector with one more slot than the
            number of frame edges meeting at that post. Additional 2-way
            connectors join pole segments along longer edge runs (one per joint
            between segments).
          </dd>
        </div>
        <div>
          <dt className="font-medium text-stone-700">Foot plates</dt>
          <dd className="mt-0.5">One per corner post.</dd>
        </div>
        <div>
          <dt className="font-medium text-stone-700">Ratchet straps & lag screws</dt>
          <dd className="mt-0.5">
            Corners (posts where exactly two frame edges meet) get two ratchet
            straps, placed at an angle along each edge rather than straight down.
            All other posts get one strap straight down. Lag screws match the
            ratchet strap count.
          </dd>
        </div>
        <div>
          <dt className="font-medium text-stone-700">Top tarps</dt>
          <dd className="mt-0.5">
            In optimal mode, adjacent cells are paired when possible (horizontal
            pairs are twice the grid width; vertical pairs are twice the grid
            height) to minimize tarp count. Unpaired cells use a single-cell
            tarp. In &ldquo;Use what I have&rdquo; mode, pairs are split into
            singles when your inventory includes at least two matching
            single-cell tarps; remaining pairs stay doubled.
          </dd>
        </div>
        <div>
          <dt className="font-medium text-stone-700">Side tarps</dt>
          <dd className="mt-0.5">
            One per side shade. Flat walls use edge length × structure height; 45°
            walls use edge length × structure height × 1.4.
          </dd>
        </div>
        <div>
          <dt className="font-medium text-stone-700">Bungee cords</dt>
          <dd className="mt-0.5">
            Grommets are spaced every 1.5 ft along each edge (rounded up). Flat
            side shades: grommets along the top edge plus both vertical edges.
            45° side shades: grommets along the sloped top edge only.
          </dd>
        </div>
        <div>
          <dt className="font-medium text-stone-700">Multiple structures</dt>
          <dd className="mt-0.5">
            The combined parts list sums all structures. Inventory singles are
            consumed in structure order when using &ldquo;Use what I have.&rdquo;
          </dd>
        </div>
      </dl>
    </details>
  );
}

function CombinedPartsList({
  structures,
  className = "",
  inventory,
  tarpMode,
  onTarpModeChange,
  onSetHave,
  onClearInventory,
}: {
  structures: StructureEntry[];
  className?: string;
  inventory: Inventory;
  tarpMode: TarpMode;
  onTarpModeChange: (mode: TarpMode) => void;
  onSetHave: (key: string, have: number) => void;
  onClearInventory: () => void;
}) {
  const radioGroupName = useId();
  const breakdown = computeCombinedPartsBreakdown(
    structures,
    tarpMode,
    inventory,
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
      <fieldset className="mb-3 flex gap-3 border-0 p-0">
        <legend className="sr-only">Tarp sizing</legend>
        <label className="flex cursor-pointer items-center gap-1.5">
          <input
            type="radio"
            name={radioGroupName}
            checked={tarpMode === "use-inventory"}
            onChange={() => onTarpModeChange("use-inventory")}
            className="border-stone-300"
          />
          <span className="text-[11px] text-stone-700">Use what I have</span>
        </label>
        <label className="flex cursor-pointer items-center gap-1.5">
          <input
            type="radio"
            name={radioGroupName}
            checked={tarpMode === "optimal"}
            onChange={() => onTarpModeChange("optimal")}
            className="border-stone-300"
          />
          <span className="text-[11px] text-stone-700">Optimal</span>
        </label>
      </fieldset>
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
      </div>
    </aside>
  );
}

function SettingsMenu({
  settings,
  onChange,
}: {
  settings: AppSettings;
  onChange: (settings: AppSettings) => void;
}) {
  return (
    <details className="relative">
      <summary className="cursor-pointer list-none rounded-lg border border-stone-300 bg-white px-3 py-1 text-sm font-medium text-stone-700 shadow-sm hover:bg-stone-50 [&::-webkit-details-marker]:hidden">
        Settings
      </summary>
      <div className="absolute right-0 z-10 mt-2 w-56 rounded-lg border border-stone-200 bg-white p-4 shadow-lg">
        <label className="block text-xs font-medium text-stone-600">
          Figma scale
          <input
            type="number"
            min={1}
            step={1}
            value={settings.figmaScale}
            onChange={(e) => {
              const next = Number(e.target.value);
              if (!Number.isFinite(next) || next <= 0) return;
              onChange({ ...settings, figmaScale: next });
            }}
            className="mt-1 w-full rounded border border-stone-300 px-2 py-1 text-sm text-stone-800"
          />
        </label>
        <p className="mt-2 text-[11px] leading-snug text-stone-500">
          Multiplier applied to SVG export dimensions for Figma.
        </p>
        <label className="mt-4 flex items-start gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={settings.showTarpOverlay}
            onChange={(e) =>
              onChange({ ...settings, showTarpOverlay: e.target.checked })
            }
            className="mt-0.5 rounded border-stone-300 shrink-0"
          />
          <span className="text-xs leading-snug text-stone-700">
            Show tarp overlay on structures
          </span>
        </label>
      </div>
    </details>
  );
}

function StructureRow({
  index,
  entry,
  canRemove,
  figmaScale,
  showTarpOverlay,
  tarpOverlays,
  partsBreakdown,
  onToggleTarpOverlay,
  onConfigChange,
  onCycleAdjacentSpot,
  onRemoveCell,
  onRemoveSideShade,
  onRemoveRow,
}: {
  index: number;
  entry: StructureEntry;
  canRemove: boolean;
  figmaScale: number;
  showTarpOverlay: boolean;
  tarpOverlays: TarpOverlay[];
  partsBreakdown: PartsBreakdown;
  onToggleTarpOverlay: (show: boolean) => void;
  onConfigChange: (config: ShapeConfig) => void;
  onCycleAdjacentSpot: (c: number, r: number) => void;
  onRemoveCell: (c: number, r: number) => void;
  onRemoveSideShade: (c: number, r: number) => void;
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
            <div className="flex items-center justify-end border-b border-stone-200 bg-stone-50 px-4 py-2">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={showTarpOverlay}
                  onChange={(e) => onToggleTarpOverlay(e.target.checked)}
                  className="rounded border-stone-300"
                />
                <span className="text-xs text-stone-600">Tarp overlay</span>
              </label>
            </div>
            <ShapeCanvas
              config={entry.config}
              state={entry.state}
              showTarpOverlay={showTarpOverlay}
              tarpOverlays={tarpOverlays}
              onCycleAdjacentSpot={onCycleAdjacentSpot}
              onRemoveCell={onRemoveCell}
              onRemoveSideShade={onRemoveSideShade}
            />
            <div className="border-t border-stone-200 bg-stone-50 px-4 py-3">
              <p className="mb-2 text-center text-xs font-medium text-stone-500">
                Export for Figma
              </p>
              <ExportSvgButtons
                config={entry.config}
                state={entry.state}
                index={index}
                figmaScale={figmaScale}
              />
            </div>
          </div>
        </div>
        <ConfigPanel config={entry.config} onChange={onConfigChange} />
        <PartsList
          breakdown={partsBreakdown}
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
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [shareCopied, setShareCopied] = useState(false);
  const [urlHydrated, setUrlHydrated] = useState(() => !isCompressedUrlState());

  useEffect(() => {
    if (!isCompressedUrlState()) return;
    let cancelled = false;
    void loadStateFromUrl().then((fromUrl) => {
      if (cancelled || !fromUrl) {
        if (!cancelled) setUrlHydrated(true);
        return;
      }
      setStructures(
        fromUrl.structures.map((s) => ({
          id: crypto.randomUUID(),
          config: { ...s.config },
          state: s.state,
        })),
      );
      setInventory(fromUrl.inventory);
      setUrlHydrated(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    localStorage.setItem(INVENTORY_STORAGE_KEY, JSON.stringify(inventory));
  }, [inventory]);

  useEffect(() => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    if (!urlHydrated) return;
    let cancelled = false;
    void buildShareUrl(structures, inventory).then((url) => {
      if (!cancelled) window.history.replaceState(null, "", url);
    });
    return () => {
      cancelled = true;
    };
  }, [structures, inventory, urlHydrated]);

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
    const url = await buildShareUrl(structures, inventory);
    try {
      await navigator.clipboard.writeText(url);
      setShareCopied(true);
      window.setTimeout(() => setShareCopied(false), 2000);
    } catch {
      window.prompt("Copy this link:", url);
    }
  }, [structures, inventory]);

  const structureBreakdowns = useMemo(
    () =>
      computeStructureBreakdowns(
        structures,
        settings.tarpMode,
        inventory,
      ),
    [structures, settings.tarpMode, inventory],
  );

  return (
    <main className="min-h-screen bg-stone-100 p-4 sm:p-8">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 lg:flex-row lg:items-start lg:gap-6">
        <aside className="hidden lg:block lg:sticky lg:top-8 lg:w-72 lg:shrink-0">
          <CombinedPartsList
            structures={structures}
            inventory={inventory}
            tarpMode={settings.tarpMode}
            onTarpModeChange={(tarpMode) =>
              setSettings((prev) => ({ ...prev, tarpMode }))
            }
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
            <SettingsMenu settings={settings} onChange={setSettings} />
          </div>
          <p className="text-stone-500 text-sm mb-4 text-center">
            Click to add a cell or cycle shade → flat wall → 45° wall.
            Right‑click to remove.
          </p>

          <CalculationsExplanation className="mb-8 w-full max-w-4xl" />

          <div className="flex w-full flex-col items-center gap-12">
            {structures.map((entry, index) => (
              <StructureRow
                key={entry.id}
                index={index}
                entry={entry}
                canRemove={structures.length > 1}
                figmaScale={settings.figmaScale}
                showTarpOverlay={settings.showTarpOverlay}
                tarpOverlays={computeTarpOverlaysForStructure(
                  structures,
                  index,
                  settings.tarpMode,
                  inventory,
                )}
                partsBreakdown={structureBreakdowns[index] ?? emptyPartsBreakdown()}
                onToggleTarpOverlay={(show) =>
                  setSettings((prev) => ({ ...prev, showTarpOverlay: show }))
                }
                onConfigChange={(config) =>
                  updateStructure(entry.id, (e) => ({ ...e, config }))
                }
                onCycleAdjacentSpot={(c, r) =>
                  updateStructure(entry.id, (e) => ({
                    ...e,
                    state: cycleAdjacentSpot(e.state, c, r),
                  }))
                }
                onRemoveCell={(c, r) =>
                  updateStructure(entry.id, (e) => ({
                    ...e,
                    state: removeCell(e.state, c, r),
                  }))
                }
                onRemoveSideShade={(c, r) =>
                  updateStructure(entry.id, (e) => ({
                    ...e,
                    state: removeSideShade(e.state, c, r),
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
              tarpMode={settings.tarpMode}
              onTarpModeChange={(tarpMode) =>
                setSettings((prev) => ({ ...prev, tarpMode }))
              }
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
