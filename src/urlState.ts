import {
  addCell,
  createInitialState,
  type ShapeState,
  type SideShade,
  type SideShadeType,
} from "./shapeState";

const DEFAULT_CONFIG = {
  gridSizeX: 10,
  gridSizeY: 10,
  height: 10,
  preferUniversalConnectors: false,
  prefer2CellTarps: true,
};

interface SerializedSideShade {
  c: number;
  r: number;
  a: number;
  b: number;
  t?: 0 | 1;
}

interface SerializedStructure {
  c: string[];
  w?: SerializedSideShade[];
  gx?: number;
  gy?: number;
  h?: number;
  u?: boolean;
  t?: boolean;
}

interface SerializedAppState {
  v: 1;
  s: SerializedStructure[];
  i?: Record<string, number>;
}

export interface DecodedConfig {
  gridSizeX: number;
  gridSizeY: number;
  height: number;
  preferUniversalConnectors: boolean;
  prefer2CellTarps: boolean;
}

export interface DecodedStructure {
  config: DecodedConfig;
  state: ShapeState;
}

export interface DecodedAppState {
  structures: DecodedStructure[];
  inventory: Record<string, number>;
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(encoded: string): string {
  const padded = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4;
  const base64 = pad ? padded + "=".repeat(4 - pad) : padded;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function stateFromCells(
  cellKeys: string[],
  sideShades: SideShade[] = [],
): ShapeState {
  if (cellKeys.length === 0) return createInitialState();
  let state: ShapeState = {
    vertices: new Map(),
    edges: new Set(),
    cells: new Set(),
    sideShades: new Map(),
  };
  for (const key of cellKeys) {
    const parts = key.split(",");
    const c = Number(parts[0]);
    const r = Number(parts[1]);
    if (!Number.isFinite(c) || !Number.isFinite(r)) continue;
    state = addCell(state, c, r);
  }
  if (state.cells.size === 0) return createInitialState();
  for (const side of sideShades) {
    const key = `${side.c},${side.r}`;
    if (state.cells.has(key) || state.sideShades.has(key)) continue;
    if (!state.cells.has(`${side.attachC},${side.attachR}`)) continue;
    state.sideShades.set(key, side);
  }
  return state;
}

function parseSideShades(raw: unknown): SideShade[] {
  if (!Array.isArray(raw)) return [];
  const out: SideShade[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Partial<SerializedSideShade>;
    if (
      typeof e.c !== "number" ||
      typeof e.r !== "number" ||
      typeof e.a !== "number" ||
      typeof e.b !== "number"
    ) {
      continue;
    }
    const type: SideShadeType = e.t === 1 ? "angle" : "flat";
    out.push({
      c: Math.floor(e.c),
      r: Math.floor(e.r),
      attachC: Math.floor(e.a),
      attachR: Math.floor(e.b),
      type,
    });
  }
  return out;
}

function parseConfig(raw: SerializedStructure): DecodedConfig {
  return {
    gridSizeX: Math.max(1, Math.floor(raw.gx ?? DEFAULT_CONFIG.gridSizeX)),
    gridSizeY: Math.max(1, Math.floor(raw.gy ?? DEFAULT_CONFIG.gridSizeY)),
    height: Math.max(1, Math.floor(raw.h ?? DEFAULT_CONFIG.height)),
    preferUniversalConnectors: raw.u ?? DEFAULT_CONFIG.preferUniversalConnectors,
    prefer2CellTarps: raw.t ?? DEFAULT_CONFIG.prefer2CellTarps,
  };
}

function parseInventory(raw: unknown): Record<string, number> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "number" && value >= 0 && Number.isFinite(value)) {
      result[key] = Math.floor(value);
    }
  }
  return result;
}

function readEncodedParam(): string | null {
  const hash = window.location.hash.slice(1);
  if (!hash) return null;
  const params = new URLSearchParams(hash);
  const encoded = params.get("s");
  return encoded && encoded.length > 0 ? encoded : null;
}

export function loadStateFromUrl(): DecodedAppState | null {
  const encoded = readEncodedParam();
  if (!encoded) return null;

  try {
    const parsed: unknown = JSON.parse(fromBase64Url(encoded));
    if (typeof parsed !== "object" || parsed === null) return null;
    const data = parsed as Partial<SerializedAppState>;
    if (data.v !== 1 || !Array.isArray(data.s) || data.s.length === 0) {
      return null;
    }

    const structures: DecodedStructure[] = [];
    for (const raw of data.s) {
      if (typeof raw !== "object" || raw === null || !Array.isArray(raw.c)) {
        continue;
      }
      const cells = raw.c.filter((key): key is string => typeof key === "string");
      if (cells.length === 0) continue;
      structures.push({
        config: parseConfig(raw),
        state: stateFromCells(cells, parseSideShades(raw.w)),
      });
    }

    if (structures.length === 0) return null;

    return {
      structures,
      inventory: parseInventory(data.i),
    };
  } catch {
    return null;
  }
}

export function encodeAppState(
  structures: Array<{ config: DecodedConfig; state: ShapeState }>,
  inventory: Record<string, number>,
): string {
  const payload: SerializedAppState = {
    v: 1,
    s: structures.map(({ config, state }) => {
      const entry: SerializedStructure = {
        c: [...state.cells],
      };
      const sides = [...state.sideShades.values()];
      if (sides.length > 0) {
        entry.w = sides.map((side) => ({
          c: side.c,
          r: side.r,
          a: side.attachC,
          b: side.attachR,
          ...(side.type === "angle" ? { t: 1 as const } : {}),
        }));
      }
      if (config.gridSizeX !== DEFAULT_CONFIG.gridSizeX) {
        entry.gx = config.gridSizeX;
      }
      if (config.gridSizeY !== DEFAULT_CONFIG.gridSizeY) {
        entry.gy = config.gridSizeY;
      }
      if (config.height !== DEFAULT_CONFIG.height) entry.h = config.height;
      if (config.preferUniversalConnectors) entry.u = true;
      if (!config.prefer2CellTarps) entry.t = false;
      return entry;
    }),
  };

  if (Object.keys(inventory).length > 0) payload.i = inventory;

  return toBase64Url(JSON.stringify(payload));
}

export function buildShareUrl(
  structures: Array<{ config: DecodedConfig; state: ShapeState }>,
  inventory: Record<string, number>,
): string {
  const url = new URL(window.location.href);
  url.hash = `s=${encodeAppState(structures, inventory)}`;
  return url.toString();
}
