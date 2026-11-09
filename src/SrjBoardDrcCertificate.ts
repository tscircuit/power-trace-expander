import Flatbush from "flatbush";
import { ConnectionNameResolver } from "./ConnectionNameResolver";
import {
  clamp,
  distance,
  distancePointToSegment,
  distanceSegmentToSegment,
} from "./geometry";
import type {
  Obstacle,
  Point,
  SimpleRouteJson,
  SimplifiedPcbTrace,
} from "./types";

export const DRC_GAP_EPSILON = 1e-6;
const SHORT_GAP_EPSILON = 1e-9;
const COINCIDENT_VIA_EPSILON = 1e-5;
const OBSTACLE_CELL_SIZE = 1.5;
const DIAGONAL_SEGMENT_CHUNK_LENGTH = 1.5;

export type SrjDrcCheckpointPhase =
  | "expansion"
  | "budget-finalization"
  | "cleanup"
  | "clearance-repair"
  | "final";

export type SrjDrcViolationKind =
  | "different_net_short"
  | "copper_clearance"
  | "via_annulus"
  | "via_drill_spacing"
  | "same_net_via_spacing"
  | "board_edge_clearance"
  | "unsupported_geometry";

export type SrjBoardDrcViolation = {
  id: string;
  kind: SrjDrcViolationKind;
  layerScope: string;
  objectIdA: string;
  objectIdB: string;
  gap: number;
  requiredGap: number;
  detail?: string;
};

export type SrjBoardDrcSignature = {
  violationsById: ReadonlyMap<string, SrjBoardDrcViolation>;
  violations: readonly SrjBoardDrcViolation[];
  violationCountByKind: Readonly<Record<SrjDrcViolationKind, number>>;
  hasUnsupportedGeometry: boolean;
  unsupportedGeometryReasons: readonly string[];
  traceSnapshotKey: string;
};

export type SrjBoardDrcRegression = {
  reason: "new_violation" | "worsened_gap" | "unsupported_geometry";
  id: string;
  kind: SrjDrcViolationKind;
  layerScope: string;
  objectIdA: string;
  objectIdB: string;
  baselineGap: number | null;
  candidateGap: number;
  requiredGap: number;
  detail?: string;
};

export type SrjBoardDrcComparison = {
  safe: boolean;
  newViolations: SrjBoardDrcViolation[];
  worsenedViolations: Array<{
    baseline: SrjBoardDrcViolation;
    candidate: SrjBoardDrcViolation;
  }>;
  resolvedViolationIds: string[];
  regressions: SrjBoardDrcRegression[];
};

export type SrjBoardDrcValidation = {
  safe: boolean;
  baseline: SrjBoardDrcSignature;
  candidate: SrjBoardDrcSignature;
  comparison: SrjBoardDrcComparison;
};

type ObbShape = {
  type: "obb";
  center: Point;
  halfWidth: number;
  halfHeight: number;
  invCos: number;
  invSin: number;
};

type ExactCopperShape =
  | { type: "segment"; start: Point; end: Point; radius: number }
  | { type: "circle"; center: Point; radius: number }
  | ObbShape;

type ObstacleClass = "pad" | "via" | "hole" | "pour" | "other";

type NetIdentity = {
  primaryNet: string | null;
  multiNetSet: ReadonlySet<string> | null;
};

type ValidatedObstacle = {
  obstacleIndex: number;
  objectId: string;
  layers: string[];
  layerMask: number;
  layerSet: ReadonlySet<string> | null;
  rawConnectedTo: string[];
  net: NetIdentity;
  obstacleClass: ObstacleClass;
  isNonPlatedHole: boolean;
  shape: ExactCopperShape;
};

type RoutedPrimitive = {
  primIndex: number;
  objectId: string;
  ownerKey: string;
  layers: string[];
  layerMask: number;
  layerSet: ReadonlySet<string> | null;
  rawConnectionNames: string[];
  net: NetIdentity;
  isVia: boolean;
  shape:
    | { type: "segment"; start: Point; end: Point; radius: number }
    | { type: "circle"; center: Point; radius: number };
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

type ValidatedVia = {
  viaIndex: number;
  objectId: string;
  ownerKey: string;
  x: number;
  y: number;
  padDiameter: number;
  holeDiameter: number;
  rawConnectionNames: string[];
  net: NetIdentity;
};

type BroadPhaseItem =
  | {
      kind: "obstacle-cell";
      minX: number;
      minY: number;
      maxX: number;
      maxY: number;
      obstacleIndex: number;
    }
  | {
      kind: "routed-cell";
      minX: number;
      minY: number;
      maxX: number;
      maxY: number;
      primIndex: number;
    };

type StaticBoardDrcContext = {
  validBoardObject: boolean;
  sanitizedSrjForResolver: SimpleRouteJson | null;
  resolver: ConnectionNameResolver | null;
  boundsValid: boolean;
  bounds: SimpleRouteJson["bounds"];
  boardLayers: string[];
  boardLayerBitByLayer: ReadonlyMap<string, number>;
  allBoardLayersMask: number;
  useLayerBitmask: boolean;
  clearance: number;
  holeClearance: number;
  minPadEdgeToPadEdgeClearance: number;
  boardEdgeClearance: number;
  minViaHoleEdgeToViaHoleEdgeClearance: number;
  defaultViaHoleDiameter: number;
  defaultViaPadDiameter: number;
  minViaAnnulus: number;
  staticViolations: SrjBoardDrcViolation[];
  staticUnsupportedReasons: string[];
  validatedObstacles: ValidatedObstacle[];
  obstacleCells: BroadPhaseItem[];
  fixedPrimitives: RoutedPrimitive[];
  fixedCells: BroadPhaseItem[];
  fixedVias: ValidatedVia[];
};

const getBoardLayers = (layerCount: number): string[] => [
  "top",
  ...Array.from(
    { length: Math.max(0, layerCount - 2) },
    (_, index) => `inner${index + 1}`,
  ),
  ...(layerCount > 1 ? ["bottom"] : []),
];

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isNonNegativeFinite = (value: unknown): boolean =>
  value === undefined || (isFiniteNumber(value) && value >= 0);

const quantizeCoord = (value: number): string => {
  const rounded = Math.round(value * 1e4) / 1e4;
  return Object.is(rounded, -0) ? "0" : String(rounded);
};

const stableSerialize = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
    .join(",")}}`;
};

const sortedPair = (a: string, b: string): [string, string] =>
  a <= b ? [a, b] : [b, a];

const buildNetIdentity = (canonicalNames: string[]): NetIdentity => {
  if (canonicalNames.length === 0) {
    return { primaryNet: null, multiNetSet: null };
  }
  if (canonicalNames.length === 1) {
    return { primaryNet: canonicalNames[0]!, multiNetSet: null };
  }
  return { primaryNet: null, multiNetSet: new Set(canonicalNames) };
};

const netsIntersect = (a: NetIdentity, b: NetIdentity): boolean => {
  if (a.primaryNet !== null) {
    if (b.primaryNet !== null) return a.primaryNet === b.primaryNet;
    return b.multiNetSet !== null && b.multiNetSet.has(a.primaryNet);
  }
  if (a.multiNetSet === null) return false;
  if (b.primaryNet !== null) return a.multiNetSet.has(b.primaryNet);
  if (b.multiNetSet === null) return false;
  const [smaller, larger] =
    a.multiNetSet.size <= b.multiNetSet.size
      ? [a.multiNetSet, b.multiNetSet]
      : [b.multiNetSet, a.multiNetSet];
  for (const item of smaller) {
    if (larger.has(item)) return true;
  }
  return false;
};

const computeLayerMask = (
  layers: readonly string[],
  bitByLayer: ReadonlyMap<string, number>,
): number => {
  let mask = 0;
  for (const layer of layers) {
    const bit = bitByLayer.get(layer);
    if (bit !== undefined) mask |= bit;
  }
  return mask;
};

const toObbLocal = (point: Point, obb: ObbShape): Point => {
  const dx = point.x - obb.center.x;
  const dy = point.y - obb.center.y;
  return {
    x: dx * obb.invCos - dy * obb.invSin,
    y: dx * obb.invSin + dy * obb.invCos,
  };
};

const fromObbLocal = (local: Point, obb: ObbShape): Point => ({
  x: obb.center.x + local.x * obb.invCos + local.y * obb.invSin,
  y: obb.center.y - local.x * obb.invSin + local.y * obb.invCos,
});

const signedDistancePointToBox = (
  local: Point,
  halfWidth: number,
  halfHeight: number,
): number => {
  const qx = Math.abs(local.x) - halfWidth;
  const qy = Math.abs(local.y) - halfHeight;
  return (
    Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0)
  );
};

const clipSegmentToBox = (
  start: Point,
  end: Point,
  halfWidth: number,
  halfHeight: number,
): { entry: number; exit: number } | null => {
  let entry = 0;
  let exit = 1;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const constraints: Array<[number, number]> = [
    [-dx, start.x + halfWidth],
    [dx, halfWidth - start.x],
    [-dy, start.y + halfHeight],
    [dy, halfHeight - start.y],
  ];
  for (const [direction, distToEdge] of constraints) {
    if (Math.abs(direction) < 1e-12) {
      if (distToEdge < 0) return null;
      continue;
    }
    const ratio = distToEdge / direction;
    if (direction < 0) entry = Math.max(entry, ratio);
    else exit = Math.min(exit, ratio);
    if (entry > exit) return null;
  }
  return { entry, exit };
};

const signedGapSegmentToObb = (
  start: Point,
  end: Point,
  radius: number,
  obb: ObbShape,
): number => {
  const localStart = toObbLocal(start, obb);
  const localEnd = toObbLocal(end, obb);
  const hw = obb.halfWidth;
  const hh = obb.halfHeight;
  const clipped = clipSegmentToBox(localStart, localEnd, hw, hh);
  if (!clipped) {
    const c0 = { x: -hw, y: -hh };
    const c1 = { x: hw, y: -hh };
    const c2 = { x: hw, y: hh };
    const c3 = { x: -hw, y: hh };
    const edgeDistance = Math.min(
      distanceSegmentToSegment(localStart, localEnd, c0, c1),
      distanceSegmentToSegment(localStart, localEnd, c1, c2),
      distanceSegmentToSegment(localStart, localEnd, c2, c3),
      distanceSegmentToSegment(localStart, localEnd, c3, c0),
    );
    return edgeDistance - radius;
  }

  const dx = localEnd.x - localStart.x;
  const dy = localEnd.y - localStart.y;
  const candidateTs = [
    clipped.entry,
    clipped.exit,
    (clipped.entry + clipped.exit) / 2,
  ];
  if (Math.abs(dx) > 1e-12) {
    candidateTs.push(clamp(-localStart.x / dx, clipped.entry, clipped.exit));
  }
  if (Math.abs(dy) > 1e-12) {
    candidateTs.push(clamp(-localStart.y / dy, clipped.entry, clipped.exit));
  }
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const denom = sx * dx - sy * dy;
      if (Math.abs(denom) > 1e-12) {
        const numer = hh - hw - (sx * localStart.x - sy * localStart.y);
        candidateTs.push(clamp(numer / denom, clipped.entry, clipped.exit));
      }
    }
  }

  let deepestSignedDistance = 0;
  for (const t of candidateTs) {
    const point = {
      x: localStart.x + dx * t,
      y: localStart.y + dy * t,
    };
    deepestSignedDistance = Math.min(
      deepestSignedDistance,
      signedDistancePointToBox(point, hw, hh),
    );
  }
  return deepestSignedDistance - radius;
};

const signedGapShapes = (
  a:
    | { type: "segment"; start: Point; end: Point; radius: number }
    | { type: "circle"; center: Point; radius: number },
  b: ExactCopperShape,
): number => {
  if (a.type === "segment") {
    if (b.type === "segment") {
      return (
        distanceSegmentToSegment(a.start, a.end, b.start, b.end) -
        a.radius -
        b.radius
      );
    }
    if (b.type === "circle") {
      return (
        distancePointToSegment(b.center, a.start, a.end) - a.radius - b.radius
      );
    }
    return signedGapSegmentToObb(a.start, a.end, a.radius, b);
  }

  if (b.type === "segment") {
    return (
      distancePointToSegment(a.center, b.start, b.end) - a.radius - b.radius
    );
  }
  if (b.type === "circle") {
    return distance(a.center, b.center) - a.radius - b.radius;
  }
  return (
    signedDistancePointToBox(
      toObbLocal(a.center, b),
      b.halfWidth,
      b.halfHeight,
    ) - a.radius
  );
};

const classifyObstacle = (obstacle: Obstacle): ObstacleClass => {
  if (obstacle.isNonPlatedHole) return "hole";
  for (const name of obstacle.connectedTo) {
    if (name.startsWith("pcb_via_")) return "via";
  }
  for (const name of obstacle.connectedTo) {
    if (name.startsWith("pcb_smtpad_") || name.startsWith("pcb_plated_hole_")) {
      return "pad";
    }
  }
  if (obstacle.isCopperPour) return "pour";
  return "other";
};

const createObstacleCells = (obstacle: ValidatedObstacle): BroadPhaseItem[] => {
  const { shape, obstacleIndex } = obstacle;
  if (shape.type === "circle") {
    return [
      {
        kind: "obstacle-cell",
        minX: shape.center.x - shape.radius,
        minY: shape.center.y - shape.radius,
        maxX: shape.center.x + shape.radius,
        maxY: shape.center.y + shape.radius,
        obstacleIndex,
      },
    ];
  }
  if (shape.type !== "obb") return [];
  if (Math.abs(shape.invSin) <= 1e-9) {
    const absCos = Math.abs(shape.invCos);
    const extentX = shape.halfWidth * absCos;
    const extentY = shape.halfHeight * absCos;
    return [
      {
        kind: "obstacle-cell",
        minX: shape.center.x - extentX,
        minY: shape.center.y - extentY,
        maxX: shape.center.x + extentX,
        maxY: shape.center.y + extentY,
        obstacleIndex,
      },
    ];
  }
  const fullWidth = shape.halfWidth * 2;
  const fullHeight = shape.halfHeight * 2;
  const columns = Math.min(
    8,
    Math.max(1, Math.ceil(fullWidth / OBSTACLE_CELL_SIZE)),
  );
  const rows = Math.min(
    8,
    Math.max(1, Math.ceil(fullHeight / OBSTACLE_CELL_SIZE)),
  );
  const cellWidth = fullWidth / columns;
  const cellHeight = fullHeight / rows;
  const cells: BroadPhaseItem[] = [];

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < columns; col++) {
      const lx0 = -shape.halfWidth + col * cellWidth;
      const lx1 = lx0 + cellWidth;
      const ly0 = -shape.halfHeight + row * cellHeight;
      const ly1 = ly0 + cellHeight;
      const c0 = fromObbLocal({ x: lx0, y: ly0 }, shape);
      const c1 = fromObbLocal({ x: lx1, y: ly0 }, shape);
      const c2 = fromObbLocal({ x: lx1, y: ly1 }, shape);
      const c3 = fromObbLocal({ x: lx0, y: ly1 }, shape);
      cells.push({
        kind: "obstacle-cell",
        minX: Math.min(c0.x, c1.x, c2.x, c3.x),
        minY: Math.min(c0.y, c1.y, c2.y, c3.y),
        maxX: Math.max(c0.x, c1.x, c2.x, c3.x),
        maxY: Math.max(c0.y, c1.y, c2.y, c3.y),
        obstacleIndex,
      });
    }
  }
  return cells;
};

const pushSegmentBroadPhaseCells = (
  cells: BroadPhaseItem[],
  start: Point,
  end: Point,
  width: number,
  primIndex: number,
) => {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const radius = width / 2;
  if (Math.abs(dx) <= 1e-6 || Math.abs(dy) <= 1e-6) {
    cells.push({
      kind: "routed-cell",
      minX: Math.min(start.x, end.x) - radius,
      minY: Math.min(start.y, end.y) - radius,
      maxX: Math.max(start.x, end.x) + radius,
      maxY: Math.max(start.y, end.y) + radius,
      primIndex,
    });
    return;
  }
  const length = Math.hypot(dx, dy);
  const chunkCount = Math.max(
    1,
    Math.ceil(length / DIAGONAL_SEGMENT_CHUNK_LENGTH),
  );
  if (chunkCount === 1) {
    cells.push({
      kind: "routed-cell",
      minX: Math.min(start.x, end.x) - radius,
      minY: Math.min(start.y, end.y) - radius,
      maxX: Math.max(start.x, end.x) + radius,
      maxY: Math.max(start.y, end.y) + radius,
      primIndex,
    });
    return;
  }
  for (let index = 0; index < chunkCount; index++) {
    const t0 = index / chunkCount;
    const t1 = (index + 1) / chunkCount;
    const x0 = start.x + dx * t0;
    const y0 = start.y + dy * t0;
    const x1 = start.x + dx * t1;
    const y1 = start.y + dy * t1;
    cells.push({
      kind: "routed-cell",
      minX: Math.min(x0, x1) - radius,
      minY: Math.min(y0, y1) - radius,
      maxX: Math.max(x0, x1) + radius,
      maxY: Math.max(y0, y1) + radius,
      primIndex,
    });
  }
};

const getUniqueTraceObjectIds = (
  traces: readonly SimplifiedPcbTrace[],
  prefix: "trace:" | "fixed_trace:",
): string[] => {
  const counts = new Map<string, number>();
  for (const trace of traces) {
    const rawId =
      typeof trace?.pcb_trace_id === "string" ? trace.pcb_trace_id : "";
    if (rawId) counts.set(rawId, (counts.get(rawId) ?? 0) + 1);
  }
  return traces.map((trace, index) => {
    const rawId =
      typeof trace?.pcb_trace_id === "string" ? trace.pcb_trace_id : "";
    if (!rawId) return `${prefix}#${index}`;
    return (counts.get(rawId) ?? 0) > 1
      ? `${prefix}${rawId}#${index}`
      : `${prefix}${rawId}`;
  });
};

const buildEmptyCountByKind = (): Record<SrjDrcViolationKind, number> => ({
  different_net_short: 0,
  copper_clearance: 0,
  via_annulus: 0,
  via_drill_spacing: 0,
  same_net_via_spacing: 0,
  board_edge_clearance: 0,
  unsupported_geometry: 0,
});

function upsertViolation(
  violationsMap: Map<string, SrjBoardDrcViolation>,
  kind: SrjDrcViolationKind,
  layerScope: string,
  rawObjectIdA: string,
  rawObjectIdB: string,
  gap: number,
  requiredGap: number,
  detail?: string,
) {
  const [objectIdA, objectIdB] = sortedPair(rawObjectIdA, rawObjectIdB);
  const id = `${kind}|${layerScope}|${objectIdA}|${objectIdB}`;
  const existing = violationsMap.get(id);
  if (!existing || gap < existing.gap) {
    violationsMap.set(id, {
      id,
      kind,
      layerScope,
      objectIdA,
      objectIdB,
      gap,
      requiredGap,
      ...(detail !== undefined
        ? { detail }
        : existing?.detail
          ? { detail: existing.detail }
          : {}),
    });
  }
}

function extractTraceGroupPrimitives({
  traceGroup,
  prefix,
  basePrimIndex,
  baseViaIndex,
  resolver,
  boardLayers,
  boardLayerBitByLayer,
  allBoardLayersMask,
  useLayerBitmask,
  boundsValid,
  bounds,
  boardEdgeClearance,
  defaultViaPadDiameter,
  defaultViaHoleDiameter,
  minViaAnnulus,
  violationsMap,
  unsupportedReasons,
}: {
  traceGroup: readonly SimplifiedPcbTrace[];
  prefix: "trace:" | "fixed_trace:";
  basePrimIndex: number;
  baseViaIndex: number;
  resolver: ConnectionNameResolver;
  boardLayers: string[];
  boardLayerBitByLayer: ReadonlyMap<string, number>;
  allBoardLayersMask: number;
  useLayerBitmask: boolean;
  boundsValid: boolean;
  bounds: SimpleRouteJson["bounds"];
  boardEdgeClearance: number;
  defaultViaPadDiameter: number;
  defaultViaHoleDiameter: number;
  minViaAnnulus: number;
  violationsMap: Map<string, SrjBoardDrcViolation>;
  unsupportedReasons: string[];
}): {
  primitives: RoutedPrimitive[];
  cells: BroadPhaseItem[];
  vias: ValidatedVia[];
  needsFreshResolver: boolean;
} {
  const primitives: RoutedPrimitive[] = [];
  const cells: BroadPhaseItem[] = [];
  const vias: ValidatedVia[] = [];
  let needsFreshResolver = false;
  const allLayersSet = useLayerBitmask ? null : new Set(boardLayers);

  const recordUnsupported = (
    layerScope: string,
    objectIdA: string,
    objectIdB: string,
    reason: string,
  ) => {
    unsupportedReasons.push(reason);
    upsertViolation(
      violationsMap,
      "unsupported_geometry",
      layerScope,
      objectIdA,
      objectIdB,
      -1,
      0,
      reason,
    );
  };

  const checkBoardEdgeBounds = (
    layerScope: string,
    objectId: string,
    minObjX: number,
    minObjY: number,
    maxObjX: number,
    maxObjY: number,
  ) => {
    if (!boundsValid) return;
    const gapMinX = minObjX - bounds.minX;
    if (gapMinX < boardEdgeClearance - DRC_GAP_EPSILON) {
      upsertViolation(
        violationsMap,
        "board_edge_clearance",
        layerScope,
        objectId,
        "board_edge:minX",
        gapMinX,
        boardEdgeClearance,
      );
    }
    const gapMaxX = bounds.maxX - maxObjX;
    if (gapMaxX < boardEdgeClearance - DRC_GAP_EPSILON) {
      upsertViolation(
        violationsMap,
        "board_edge_clearance",
        layerScope,
        objectId,
        "board_edge:maxX",
        gapMaxX,
        boardEdgeClearance,
      );
    }
    const gapMinY = minObjY - bounds.minY;
    if (gapMinY < boardEdgeClearance - DRC_GAP_EPSILON) {
      upsertViolation(
        violationsMap,
        "board_edge_clearance",
        layerScope,
        objectId,
        "board_edge:minY",
        gapMinY,
        boardEdgeClearance,
      );
    }
    const gapMaxY = bounds.maxY - maxObjY;
    if (gapMaxY < boardEdgeClearance - DRC_GAP_EPSILON) {
      upsertViolation(
        violationsMap,
        "board_edge_clearance",
        layerScope,
        objectId,
        "board_edge:maxY",
        gapMaxY,
        boardEdgeClearance,
      );
    }
  };

  const objectIds = getUniqueTraceObjectIds(traceGroup, prefix);
  for (let traceIndex = 0; traceIndex < traceGroup.length; traceIndex++) {
    const trace = traceGroup[traceIndex]!;
    const traceObjectId = objectIds[traceIndex]!;
    if (!trace || typeof trace !== "object" || !Array.isArray(trace.route)) {
      recordUnsupported(
        "all",
        traceObjectId,
        traceObjectId,
        `Malformed trace object at ${traceObjectId}`,
      );
      continue;
    }

    const rawConnectionNames = [
      trace.pcb_trace_id,
      trace.connection_name,
      trace.source_trace_id,
      trace.rootConnectionName,
      ...(Array.isArray(trace.mergedConnectionNames)
        ? trace.mergedConnectionNames
        : []),
      ...(Array.isArray(trace.connectsTo) ? trace.connectsTo : []),
    ].filter(
      (name): name is string => typeof name === "string" && name.length > 0,
    );
    const canonicalNames = resolver.canonicalize(rawConnectionNames);
    if (canonicalNames.length > 1) {
      needsFreshResolver = true;
    }
    const net = buildNetIdentity(canonicalNames);

    const validWireAt = new Uint8Array(trace.route.length);

    for (let routeIndex = 0; routeIndex < trace.route.length; routeIndex++) {
      const point = trace.route[routeIndex] as
        | SimplifiedPcbTrace["route"][number]
        | undefined;
      if (!point || typeof point !== "object") {
        recordUnsupported(
          "all",
          traceObjectId,
          `route_index:${routeIndex}`,
          `Nullish route point at ${traceObjectId}[${routeIndex}]`,
        );
        continue;
      }

      if (point.route_type === "wire") {
        if (
          !isFiniteNumber(point.x) ||
          !isFiniteNumber(point.y) ||
          !isFiniteNumber(point.width) ||
          point.width <= 0 ||
          typeof point.layer !== "string" ||
          !boardLayerBitByLayer.has(point.layer)
        ) {
          recordUnsupported(
            typeof point.layer === "string" ? point.layer : "all",
            traceObjectId,
            "route_type:wire",
            `Invalid wire route point on ${traceObjectId}[${routeIndex}]`,
          );
          continue;
        }
        validWireAt[routeIndex] = 1;
        continue;
      }

      if (point.route_type === "via") {
        const padDiameter = point.via_diameter ?? defaultViaPadDiameter;
        const holeDiameter = point.via_hole_diameter ?? defaultViaHoleDiameter;
        if (
          !isFiniteNumber(point.x) ||
          !isFiniteNumber(point.y) ||
          !isFiniteNumber(padDiameter) ||
          padDiameter <= 0 ||
          !isFiniteNumber(holeDiameter) ||
          holeDiameter <= 0 ||
          typeof point.from_layer !== "string" ||
          typeof point.to_layer !== "string" ||
          !boardLayerBitByLayer.has(point.from_layer) ||
          !boardLayerBitByLayer.has(point.to_layer)
        ) {
          recordUnsupported(
            "all",
            traceObjectId,
            "route_type:via",
            `Invalid via route point on ${traceObjectId}[${routeIndex}]`,
          );
          continue;
        }

        const viaObjectId = `via:${traceObjectId}@${quantizeCoord(point.x)},${quantizeCoord(point.y)}`;
        const annulus = (padDiameter - holeDiameter) / 2;
        if (annulus < minViaAnnulus - DRC_GAP_EPSILON) {
          upsertViolation(
            violationsMap,
            "via_annulus",
            "all",
            viaObjectId,
            viaObjectId,
            annulus,
            minViaAnnulus,
          );
        }

        const padRadius = padDiameter / 2;
        const minX = point.x - padRadius;
        const minY = point.y - padRadius;
        const maxX = point.x + padRadius;
        const maxY = point.y + padRadius;
        checkBoardEdgeBounds("all", viaObjectId, minX, minY, maxX, maxY);

        const primIndex = basePrimIndex + primitives.length;
        primitives.push({
          primIndex,
          objectId: viaObjectId,
          ownerKey: traceObjectId,
          layers: boardLayers,
          layerMask: allBoardLayersMask,
          layerSet: allLayersSet,
          rawConnectionNames,
          net,
          isVia: true,
          shape: {
            type: "circle",
            center: { x: point.x, y: point.y },
            radius: padRadius,
          },
          minX,
          minY,
          maxX,
          maxY,
        });
        cells.push({
          kind: "routed-cell",
          minX,
          minY,
          maxX,
          maxY,
          primIndex,
        });

        vias.push({
          viaIndex: baseViaIndex + vias.length,
          objectId: viaObjectId,
          ownerKey: traceObjectId,
          x: point.x,
          y: point.y,
          padDiameter,
          holeDiameter,
          rawConnectionNames,
          net,
        });
        continue;
      }

      const routeTypeLabel = String(
        (point as { route_type?: unknown }).route_type ?? "unknown",
      );
      const layerLabel =
        "layer" in point && typeof point.layer === "string"
          ? point.layer
          : "all";
      recordUnsupported(
        layerLabel,
        traceObjectId,
        `route_type:${routeTypeLabel}`,
        `Unsupported route_type "${routeTypeLabel}" on ${traceObjectId}[${routeIndex}]`,
      );
    }

    for (let routeIndex = 0; routeIndex < trace.route.length; routeIndex++) {
      if (validWireAt[routeIndex] === 0) continue;
      const current = trace.route[routeIndex] as Extract<
        SimplifiedPcbTrace["route"][number],
        { route_type: "wire" }
      >;
      const next =
        validWireAt[routeIndex + 1] === 1
          ? (trace.route[routeIndex + 1] as Extract<
              SimplifiedPcbTrace["route"][number],
              { route_type: "wire" }
            >)
          : undefined;
      const prev =
        routeIndex > 0 && validWireAt[routeIndex - 1] === 1
          ? (trace.route[routeIndex - 1] as Extract<
              SimplifiedPcbTrace["route"][number],
              { route_type: "wire" }
            >)
          : undefined;

      const hasSameLayerNext = Boolean(next && next.layer === current.layer);
      const hasSameLayerPrev = Boolean(prev && prev.layer === current.layer);

      if (!hasSameLayerNext && hasSameLayerPrev) {
        continue;
      }

      const endPoint = hasSameLayerNext ? next! : current;
      const segWidth = current.width;
      const segRadius = segWidth / 2;
      const minX = Math.min(current.x, endPoint.x) - segRadius;
      const minY = Math.min(current.y, endPoint.y) - segRadius;
      const maxX = Math.max(current.x, endPoint.x) + segRadius;
      const maxY = Math.max(current.y, endPoint.y) + segRadius;

      checkBoardEdgeBounds(
        current.layer,
        traceObjectId,
        minX,
        minY,
        maxX,
        maxY,
      );

      const primIndex = basePrimIndex + primitives.length;
      const layerBit = boardLayerBitByLayer.get(current.layer) ?? 0;
      primitives.push({
        primIndex,
        objectId: traceObjectId,
        ownerKey: traceObjectId,
        layers: [current.layer],
        layerMask: layerBit,
        layerSet: useLayerBitmask ? null : new Set([current.layer]),
        rawConnectionNames,
        net,
        isVia: false,
        shape: {
          type: "segment",
          start: { x: current.x, y: current.y },
          end: { x: endPoint.x, y: endPoint.y },
          radius: segRadius,
        },
        minX,
        minY,
        maxX,
        maxY,
      });

      pushSegmentBroadPhaseCells(cells, current, endPoint, segWidth, primIndex);
    }
  }

  return { primitives, cells, vias, needsFreshResolver };
}

function buildStaticBoardDrcContext(
  simpleRouteJson: SimpleRouteJson,
  initialTraces: readonly SimplifiedPcbTrace[],
  existingResolver?: ConnectionNameResolver,
): StaticBoardDrcContext {
  const staticViolationsMap = new Map<string, SrjBoardDrcViolation>();
  const staticUnsupportedReasons: string[] = [];

  const recordStaticUnsupported = (
    layerScope: string,
    objectIdA: string,
    objectIdB: string,
    reason: string,
  ) => {
    staticUnsupportedReasons.push(reason);
    upsertViolation(
      staticViolationsMap,
      "unsupported_geometry",
      layerScope,
      objectIdA,
      objectIdB,
      -1,
      0,
      reason,
    );
  };

  if (!simpleRouteJson || typeof simpleRouteJson !== "object") {
    recordStaticUnsupported(
      "all",
      "board",
      "board",
      "Missing SimpleRouteJson object",
    );
    return {
      validBoardObject: false,
      sanitizedSrjForResolver: null,
      resolver: null,
      boundsValid: false,
      bounds: { minX: -1000, maxX: 1000, minY: -1000, maxY: 1000 },
      boardLayers: ["top", "bottom"],
      boardLayerBitByLayer: new Map([
        ["top", 1],
        ["bottom", 2],
      ]),
      allBoardLayersMask: 3,
      useLayerBitmask: true,
      clearance: 0.1,
      holeClearance: 0.1,
      minPadEdgeToPadEdgeClearance: 0.1,
      boardEdgeClearance: 0.1,
      minViaHoleEdgeToViaHoleEdgeClearance: 0.1,
      defaultViaHoleDiameter: 0.3,
      defaultViaPadDiameter: 0.6,
      minViaAnnulus: 0.05,
      staticViolations: [...staticViolationsMap.values()],
      staticUnsupportedReasons,
      validatedObstacles: [],
      obstacleCells: [],
      fixedPrimitives: [],
      fixedCells: [],
      fixedVias: [],
    };
  }

  const layerCountValid =
    Number.isInteger(simpleRouteJson.layerCount) &&
    simpleRouteJson.layerCount >= 1;
  if (!layerCountValid) {
    recordStaticUnsupported(
      "all",
      "board:layerCount",
      "board:layerCount",
      `Unsupported layerCount: ${String(simpleRouteJson.layerCount)}`,
    );
  }
  const safeLayerCount = layerCountValid ? simpleRouteJson.layerCount : 2;

  const bounds = simpleRouteJson.bounds;
  const boundsValid =
    Boolean(bounds) &&
    isFiniteNumber(bounds.minX) &&
    isFiniteNumber(bounds.maxX) &&
    isFiniteNumber(bounds.minY) &&
    isFiniteNumber(bounds.maxY) &&
    bounds.minX < bounds.maxX &&
    bounds.minY < bounds.maxY;
  if (!boundsValid) {
    recordStaticUnsupported(
      "all",
      "board:bounds",
      "board:bounds",
      "Invalid or non-finite board bounds",
    );
  }
  const safeBounds = boundsValid
    ? bounds
    : { minX: -1000, maxX: 1000, minY: -1000, maxY: 1000 };

  const ruleFields: Array<[string, unknown]> = [
    ["minTraceWidth", simpleRouteJson.minTraceWidth],
    ["nominalTraceWidth", simpleRouteJson.nominalTraceWidth],
    ["minViaDiameter", simpleRouteJson.minViaDiameter],
    ["minViaHoleDiameter", simpleRouteJson.minViaHoleDiameter],
    ["minViaPadDiameter", simpleRouteJson.minViaPadDiameter],
    ["min_via_hole_diameter", simpleRouteJson.min_via_hole_diameter],
    ["min_via_pad_diameter", simpleRouteJson.min_via_pad_diameter],
    ["defaultObstacleMargin", simpleRouteJson.defaultObstacleMargin],
    ["minTraceToPadEdgeClearance", simpleRouteJson.minTraceToPadEdgeClearance],
    [
      "minPadEdgeToPadEdgeClearance",
      simpleRouteJson.minPadEdgeToPadEdgeClearance,
    ],
    [
      "minTraceToHoleEdgeClearance",
      simpleRouteJson.minTraceToHoleEdgeClearance,
    ],
    ["minBoardEdgeClearance", simpleRouteJson.minBoardEdgeClearance],
    [
      "minViaHoleEdgeToViaHoleEdgeClearance",
      simpleRouteJson.minViaHoleEdgeToViaHoleEdgeClearance,
    ],
  ];
  for (const [fieldName, fieldValue] of ruleFields) {
    if (!isNonNegativeFinite(fieldValue)) {
      recordStaticUnsupported(
        "all",
        `board:${fieldName}`,
        `board:${fieldName}`,
        `Invalid numeric DRC rule ${fieldName}: ${String(fieldValue)}`,
      );
    }
  }

  const boardLayers = getBoardLayers(safeLayerCount);
  const useLayerBitmask = boardLayers.length <= 30;
  const boardLayerBitByLayer = new Map<string, number>();
  let allBoardLayersMask = 0;
  for (let idx = 0; idx < boardLayers.length; idx++) {
    const bit = useLayerBitmask ? 1 << idx : 0;
    boardLayerBitByLayer.set(boardLayers[idx]!, bit);
    allBoardLayersMask |= bit;
  }

  const safeNonNegative = (value: unknown, fallback: number): number =>
    isFiniteNumber(value) && value >= 0 ? value : fallback;

  const clearance = Math.max(
    safeNonNegative(simpleRouteJson.defaultObstacleMargin, 0),
    safeNonNegative(simpleRouteJson.minTraceToPadEdgeClearance, 0),
    0.1,
  );
  const holeClearance = safeNonNegative(
    simpleRouteJson.minTraceToHoleEdgeClearance,
    clearance,
  );
  const minPadEdgeToPadEdgeClearance = safeNonNegative(
    simpleRouteJson.minPadEdgeToPadEdgeClearance,
    clearance,
  );
  const boardEdgeClearance = safeNonNegative(
    simpleRouteJson.minBoardEdgeClearance,
    clearance,
  );
  const minViaHoleEdgeToViaHoleEdgeClearance = Math.max(
    safeNonNegative(simpleRouteJson.minViaHoleEdgeToViaHoleEdgeClearance, 0),
    0.1,
  );
  const rawDefaultViaHoleDiameter =
    simpleRouteJson.min_via_hole_diameter ?? simpleRouteJson.minViaHoleDiameter;
  const defaultViaHoleDiameter =
    isFiniteNumber(rawDefaultViaHoleDiameter) && rawDefaultViaHoleDiameter > 0
      ? rawDefaultViaHoleDiameter
      : 0.3;
  const declaredViaPadDiameter =
    simpleRouteJson.min_via_pad_diameter ??
    simpleRouteJson.minViaPadDiameter ??
    simpleRouteJson.minViaDiameter;
  const declaredViaHoleDiameter =
    simpleRouteJson.min_via_hole_diameter ?? simpleRouteJson.minViaHoleDiameter;
  const defaultViaPadDiameter =
    isFiniteNumber(declaredViaPadDiameter) && declaredViaPadDiameter > 0
      ? declaredViaPadDiameter
      : 0.6;
  const minViaAnnulus =
    isFiniteNumber(declaredViaPadDiameter) &&
    isFiniteNumber(declaredViaHoleDiameter) &&
    declaredViaPadDiameter > declaredViaHoleDiameter
      ? (declaredViaPadDiameter - declaredViaHoleDiameter) / 2
      : 0.05;

  const rawObstacles = Array.isArray(simpleRouteJson.obstacles)
    ? simpleRouteJson.obstacles
    : (() => {
        recordStaticUnsupported(
          "all",
          "board:obstacles",
          "board:obstacles",
          "Obstacles field is not an array",
        );
        return [];
      })();
  const rawFixedTraces = Array.isArray(simpleRouteJson.fixedTraces)
    ? simpleRouteJson.fixedTraces
    : simpleRouteJson.fixedTraces === undefined
      ? []
      : (() => {
          recordStaticUnsupported(
            "all",
            "board:fixedTraces",
            "board:fixedTraces",
            "fixedTraces field is not an array",
          );
          return [];
        })();

  const sanitizedSrjForResolver: SimpleRouteJson = {
    ...simpleRouteJson,
    connections: Array.isArray(simpleRouteJson.connections)
      ? simpleRouteJson.connections.filter(
          (conn) => Boolean(conn) && Array.isArray(conn.pointsToConnect),
        )
      : [],
    obstacles: rawObstacles.filter(
      (obs) => Boolean(obs) && Array.isArray(obs.connectedTo),
    ),
    fixedTraces: rawFixedTraces.filter((trace) => Boolean(trace)),
  };
  const safeInitialTraces = Array.isArray(initialTraces)
    ? (initialTraces.filter((trace) => Boolean(trace)) as SimplifiedPcbTrace[])
    : [];
  const resolver =
    existingResolver ??
    new ConnectionNameResolver(sanitizedSrjForResolver, safeInitialTraces);

  const validatedObstacles: ValidatedObstacle[] = [];
  const obstacleCells: BroadPhaseItem[] = [];

  for (let index = 0; index < rawObstacles.length; index++) {
    const obstacle = rawObstacles[index]!;
    const objectId = `obstacle:${obstacle?.obstacleId ?? index}`;
    if (
      !obstacle ||
      typeof obstacle !== "object" ||
      !obstacle.center ||
      !isFiniteNumber(obstacle.center.x) ||
      !isFiniteNumber(obstacle.center.y) ||
      !isFiniteNumber(obstacle.width) ||
      !isFiniteNumber(obstacle.height) ||
      obstacle.width <= 0 ||
      obstacle.height <= 0 ||
      (obstacle.ccwRotationDegrees !== undefined &&
        !isFiniteNumber(obstacle.ccwRotationDegrees)) ||
      !Array.isArray(obstacle.layers) ||
      obstacle.layers.length === 0 ||
      !Array.isArray(obstacle.connectedTo)
    ) {
      recordStaticUnsupported(
        "all",
        objectId,
        objectId,
        `Malformed obstacle geometry at ${objectId}`,
      );
      continue;
    }

    const unknownLayer = obstacle.layers.find(
      (layer) => typeof layer !== "string" || !boardLayerBitByLayer.has(layer),
    );
    if (unknownLayer !== undefined) {
      recordStaticUnsupported(
        String(unknownLayer),
        objectId,
        objectId,
        `Unsupported obstacle layer ${String(unknownLayer)} on ${objectId}`,
      );
      continue;
    }

    const rawType = (obstacle as { type?: unknown }).type;
    const rawShape = (obstacle as { shape?: unknown }).shape;
    let exactShape: ExactCopperShape | null = null;

    if (
      (rawType === "rect" && rawShape === "circle") ||
      (rawType === "oval" && (rawShape === undefined || rawShape === "circle"))
    ) {
      if (Math.abs(obstacle.width - obstacle.height) > 1e-4) {
        recordStaticUnsupported(
          "all",
          objectId,
          objectId,
          `Non-circular ${String(rawType)} obstacle (${obstacle.width}x${obstacle.height}) on ${objectId}`,
        );
        continue;
      }
      exactShape = {
        type: "circle",
        center: { x: obstacle.center.x, y: obstacle.center.y },
        radius: (obstacle.width + obstacle.height) / 4,
      };
    } else if (
      rawType === "rect" &&
      (rawShape === undefined || rawShape === "rect")
    ) {
      const invRadians = -(
        ((obstacle.ccwRotationDegrees ?? 0) * Math.PI) /
        180
      );
      exactShape = {
        type: "obb",
        center: { x: obstacle.center.x, y: obstacle.center.y },
        halfWidth: obstacle.width / 2,
        halfHeight: obstacle.height / 2,
        invCos: Math.cos(invRadians),
        invSin: Math.sin(invRadians),
      };
    } else {
      recordStaticUnsupported(
        "all",
        objectId,
        objectId,
        `Unsupported obstacle primitive type=${String(rawType)} shape=${String(rawShape)} on ${objectId}`,
      );
      continue;
    }

    // All names in obstacle.connectedTo are unioned together in ConnectionNameResolver.
    const firstConnectedName = obstacle.connectedTo.find(
      (name): name is string => typeof name === "string" && name.length > 0,
    );
    const canonicalObstacleNames = firstConnectedName
      ? resolver.canonicalize([firstConnectedName])
      : [];

    const validatedObstacle: ValidatedObstacle = {
      obstacleIndex: validatedObstacles.length,
      objectId,
      layers: obstacle.layers,
      layerMask: computeLayerMask(obstacle.layers, boardLayerBitByLayer),
      layerSet: useLayerBitmask ? null : new Set(obstacle.layers),
      rawConnectedTo: obstacle.connectedTo,
      net: buildNetIdentity(canonicalObstacleNames),
      obstacleClass: classifyObstacle(obstacle),
      isNonPlatedHole: Boolean(obstacle.isNonPlatedHole),
      shape: exactShape,
    };
    validatedObstacles.push(validatedObstacle);
    obstacleCells.push(...createObstacleCells(validatedObstacle));
  }

  const fixedExtracted = extractTraceGroupPrimitives({
    traceGroup: rawFixedTraces,
    prefix: "fixed_trace:",
    basePrimIndex: 0,
    baseViaIndex: 0,
    resolver,
    boardLayers,
    boardLayerBitByLayer,
    allBoardLayersMask,
    useLayerBitmask,
    boundsValid,
    bounds: safeBounds,
    boardEdgeClearance,
    defaultViaPadDiameter,
    defaultViaHoleDiameter,
    minViaAnnulus,
    violationsMap: staticViolationsMap,
    unsupportedReasons: staticUnsupportedReasons,
  });

  return {
    validBoardObject: true,
    sanitizedSrjForResolver,
    resolver,
    boundsValid,
    bounds: safeBounds,
    boardLayers,
    boardLayerBitByLayer,
    allBoardLayersMask,
    useLayerBitmask,
    clearance,
    holeClearance,
    minPadEdgeToPadEdgeClearance,
    boardEdgeClearance,
    minViaHoleEdgeToViaHoleEdgeClearance,
    defaultViaHoleDiameter,
    defaultViaPadDiameter,
    minViaAnnulus,
    staticViolations: [...staticViolationsMap.values()],
    staticUnsupportedReasons,
    validatedObstacles,
    obstacleCells,
    fixedPrimitives: fixedExtracted.primitives,
    fixedCells: fixedExtracted.cells,
    fixedVias: fixedExtracted.vias,
  };
}

function forEachSharedLayer(
  context: StaticBoardDrcContext,
  prim: RoutedPrimitive,
  otherLayersMask: number,
  otherLayerSet: ReadonlySet<string> | null,
  callback: (layer: string) => void,
) {
  if (context.useLayerBitmask) {
    let sharedMask = prim.layerMask & otherLayersMask;
    let bitIndex = 0;
    while (sharedMask !== 0) {
      if ((sharedMask & 1) !== 0) {
        callback(context.boardLayers[bitIndex]!);
      }
      sharedMask >>>= 1;
      bitIndex++;
    }
    return;
  }
  if (!otherLayerSet) return;
  for (const layer of prim.layers) {
    if (otherLayerSet.has(layer)) callback(layer);
  }
}

function evaluateSignatureWithContext(
  context: StaticBoardDrcContext,
  traces: readonly SimplifiedPcbTrace[],
  forceSnapshotKey = false,
): SrjBoardDrcSignature {
  const violationsMap = new Map<string, SrjBoardDrcViolation>();
  for (const staticViolation of context.staticViolations) {
    violationsMap.set(staticViolation.id, staticViolation);
  }
  const unsupportedReasons = [...context.staticUnsupportedReasons];

  if (!context.validBoardObject || !context.resolver) {
    return finalizeSignature(violationsMap, unsupportedReasons, traces, true);
  }

  try {
    const rawMutableTraces = Array.isArray(traces)
      ? traces
      : (() => {
          const reason = "traces argument is not an array";
          unsupportedReasons.push(reason);
          upsertViolation(
            violationsMap,
            "unsupported_geometry",
            "all",
            "board:traces",
            "board:traces",
            -1,
            0,
            reason,
          );
          return [];
        })();

    const mutableExtracted = extractTraceGroupPrimitives({
      traceGroup: rawMutableTraces,
      prefix: "trace:",
      basePrimIndex: context.fixedPrimitives.length,
      baseViaIndex: context.fixedVias.length,
      resolver: context.resolver,
      boardLayers: context.boardLayers,
      boardLayerBitByLayer: context.boardLayerBitByLayer,
      allBoardLayersMask: context.allBoardLayersMask,
      useLayerBitmask: context.useLayerBitmask,
      boundsValid: context.boundsValid,
      bounds: context.bounds,
      boardEdgeClearance: context.boardEdgeClearance,
      defaultViaPadDiameter: context.defaultViaPadDiameter,
      defaultViaHoleDiameter: context.defaultViaHoleDiameter,
      minViaAnnulus: context.minViaAnnulus,
      violationsMap,
      unsupportedReasons,
    });

    let activeObstacles = context.validatedObstacles;
    let routedPrimitives =
      context.fixedPrimitives.length === 0
        ? mutableExtracted.primitives
        : [...context.fixedPrimitives, ...mutableExtracted.primitives];
    let validatedVias =
      context.fixedVias.length === 0
        ? mutableExtracted.vias
        : [...context.fixedVias, ...mutableExtracted.vias];

    if (
      mutableExtracted.needsFreshResolver &&
      context.sanitizedSrjForResolver
    ) {
      const freshResolver = new ConnectionNameResolver(
        context.sanitizedSrjForResolver,
        rawMutableTraces.filter((trace) =>
          Boolean(trace),
        ) as SimplifiedPcbTrace[],
      );
      activeObstacles = context.validatedObstacles.map((obs) => ({
        ...obs,
        net: buildNetIdentity(
          freshResolver.canonicalize(
            obs.rawConnectedTo.filter(
              (name): name is string =>
                typeof name === "string" && name.length > 0,
            ),
          ),
        ),
      }));
      routedPrimitives = routedPrimitives.map((prim) => ({
        ...prim,
        net: buildNetIdentity(
          freshResolver.canonicalize(prim.rawConnectionNames),
        ),
      }));
      validatedVias = validatedVias.map((via) => ({
        ...via,
        net: buildNetIdentity(
          freshResolver.canonicalize(via.rawConnectionNames),
        ),
      }));
    }

    const totalCellCount =
      context.obstacleCells.length +
      context.fixedCells.length +
      mutableExtracted.cells.length;

    if (totalCellCount > 0 && routedPrimitives.length > 0) {
      const copperIndex = new Flatbush(totalCellCount);
      const obstacleCellCount = context.obstacleCells.length;
      const fixedCellCount = context.fixedCells.length;
      const obstacleAndFixedCount = obstacleCellCount + fixedCellCount;

      for (let i = 0; i < obstacleCellCount; i++) {
        const item = context.obstacleCells[i]!;
        copperIndex.add(item.minX, item.minY, item.maxX, item.maxY);
      }
      for (let i = 0; i < fixedCellCount; i++) {
        const item = context.fixedCells[i]!;
        copperIndex.add(item.minX, item.minY, item.maxX, item.maxY);
      }
      for (let i = 0; i < mutableExtracted.cells.length; i++) {
        const item = mutableExtracted.cells[i]!;
        copperIndex.add(item.minX, item.minY, item.maxX, item.maxY);
      }
      copperIndex.finish();

      const {
        clearance,
        holeClearance,
        minPadEdgeToPadEdgeClearance,
        useLayerBitmask,
      } = context;
      const maxSearchMargin = Math.max(
        clearance,
        holeClearance,
        minPadEdgeToPadEdgeClearance,
      );
      const seenObstacleStamp = new Int32Array(activeObstacles.length).fill(-1);
      const seenPrimStamp = new Int32Array(routedPrimitives.length).fill(-1);

      for (let primIdx = 0; primIdx < routedPrimitives.length; primIdx++) {
        const prim = routedPrimitives[primIdx]!;
        let candidateIndices: number[];
        if (
          prim.shape.type === "segment" &&
          prim.maxX - prim.minX > 2 &&
          prim.maxY - prim.minY > 2
        ) {
          const { start, end, radius } = prim.shape;
          const segDx = end.x - start.x;
          const segDy = end.y - start.y;
          const chunks = Math.max(2, Math.ceil(Math.hypot(segDx, segDy) / 1.5));
          candidateIndices = [];
          for (let c = 0; c < chunks; c++) {
            const t0 = c / chunks;
            const t1 = (c + 1) / chunks;
            const x0 = start.x + segDx * t0;
            const y0 = start.y + segDy * t0;
            const x1 = start.x + segDx * t1;
            const y1 = start.y + segDy * t1;
            const subHits = copperIndex.search(
              Math.min(x0, x1) - radius - maxSearchMargin,
              Math.min(y0, y1) - radius - maxSearchMargin,
              Math.max(x0, x1) + radius + maxSearchMargin,
              Math.max(y0, y1) + radius + maxSearchMargin,
            );
            for (let s = 0; s < subHits.length; s++) {
              candidateIndices.push(subHits[s]!);
            }
          }
        } else {
          candidateIndices = copperIndex.search(
            prim.minX - maxSearchMargin,
            prim.minY - maxSearchMargin,
            prim.maxX + maxSearchMargin,
            prim.maxY + maxSearchMargin,
          );
        }

        for (let cIdx = 0; cIdx < candidateIndices.length; cIdx++) {
          const itemIdx = candidateIndices[cIdx]!;
          const item =
            itemIdx < obstacleCellCount
              ? context.obstacleCells[itemIdx]!
              : itemIdx < obstacleAndFixedCount
                ? context.fixedCells[itemIdx - obstacleCellCount]!
                : mutableExtracted.cells[itemIdx - obstacleAndFixedCount]!;

          if (item.kind === "obstacle-cell") {
            const obsIdx = item.obstacleIndex;
            if (seenObstacleStamp[obsIdx] === primIdx) continue;
            seenObstacleStamp[obsIdx] = primIdx;

            const obs = activeObstacles[obsIdx]!;
            if (useLayerBitmask) {
              if ((prim.layerMask & obs.layerMask) === 0) continue;
            } else if (
              !obs.layerSet ||
              !prim.layers.some((layer) => obs.layerSet!.has(layer))
            ) {
              continue;
            }
            if (netsIntersect(prim.net, obs.net)) continue;

            const requiredClearance =
              prim.isVia && obs.obstacleClass === "via"
                ? minPadEdgeToPadEdgeClearance
                : !prim.isVia && obs.obstacleClass === "hole"
                  ? holeClearance
                  : clearance;

            const gap = signedGapShapes(prim.shape, obs.shape);
            if (gap < requiredClearance - DRC_GAP_EPSILON) {
              const isShort = !obs.isNonPlatedHole && gap <= SHORT_GAP_EPSILON;
              forEachSharedLayer(
                context,
                prim,
                obs.layerMask,
                obs.layerSet,
                (layer) => {
                  upsertViolation(
                    violationsMap,
                    "copper_clearance",
                    layer,
                    prim.objectId,
                    obs.objectId,
                    gap,
                    requiredClearance,
                  );
                  if (isShort) {
                    upsertViolation(
                      violationsMap,
                      "different_net_short",
                      layer,
                      prim.objectId,
                      obs.objectId,
                      gap,
                      0,
                    );
                  }
                },
              );
            }
          } else {
            const otherIdx = item.primIndex;
            if (otherIdx <= primIdx) continue;
            if (seenPrimStamp[otherIdx] === primIdx) continue;
            seenPrimStamp[otherIdx] = primIdx;

            const other = routedPrimitives[otherIdx]!;
            if (prim.ownerKey === other.ownerKey) continue;
            if (useLayerBitmask) {
              if ((prim.layerMask & other.layerMask) === 0) continue;
            } else if (
              !other.layerSet ||
              !prim.layers.some((layer) => other.layerSet!.has(layer))
            ) {
              continue;
            }
            if (netsIntersect(prim.net, other.net)) continue;

            const requiredClearance =
              prim.isVia && other.isVia
                ? minPadEdgeToPadEdgeClearance
                : clearance;
            const gap = signedGapShapes(prim.shape, other.shape);
            if (gap < requiredClearance - DRC_GAP_EPSILON) {
              const isShort = gap <= SHORT_GAP_EPSILON;
              forEachSharedLayer(
                context,
                prim,
                other.layerMask,
                other.layerSet,
                (layer) => {
                  upsertViolation(
                    violationsMap,
                    "copper_clearance",
                    layer,
                    prim.objectId,
                    other.objectId,
                    gap,
                    requiredClearance,
                  );
                  if (isShort) {
                    upsertViolation(
                      violationsMap,
                      "different_net_short",
                      layer,
                      prim.objectId,
                      other.objectId,
                      gap,
                      0,
                    );
                  }
                },
              );
            }
          }
        }
      }
    }

    if (validatedVias.length > 1) {
      const viaDrillIndex = new Flatbush(validatedVias.length);
      let maxViaHoleDiameter = 0;
      for (let i = 0; i < validatedVias.length; i++) {
        const via = validatedVias[i]!;
        const holeRadius = via.holeDiameter / 2;
        maxViaHoleDiameter = Math.max(maxViaHoleDiameter, via.holeDiameter);
        viaDrillIndex.add(
          via.x - holeRadius,
          via.y - holeRadius,
          via.x + holeRadius,
          via.y + holeRadius,
        );
      }
      viaDrillIndex.finish();

      const minDrillClearance = context.minViaHoleEdgeToViaHoleEdgeClearance;
      for (let i = 0; i < validatedVias.length; i++) {
        const viaA = validatedVias[i]!;
        const searchRadius =
          viaA.holeDiameter / 2 + maxViaHoleDiameter / 2 + minDrillClearance;
        const nearbyIndices = viaDrillIndex.search(
          viaA.x - searchRadius,
          viaA.y - searchRadius,
          viaA.x + searchRadius,
          viaA.y + searchRadius,
        );
        for (let k = 0; k < nearbyIndices.length; k++) {
          const j = nearbyIndices[k]!;
          if (j <= i) continue;
          const viaB = validatedVias[j]!;
          const centerDist = Math.hypot(viaB.x - viaA.x, viaB.y - viaA.y);
          const drillGap =
            centerDist - viaA.holeDiameter / 2 - viaB.holeDiameter / 2;
          const isSameNet =
            viaA.ownerKey === viaB.ownerKey ||
            netsIntersect(viaA.net, viaB.net);

          if (isSameNet) {
            if (centerDist <= COINCIDENT_VIA_EPSILON) {
              continue;
            }
            if (drillGap < minDrillClearance - DRC_GAP_EPSILON) {
              upsertViolation(
                violationsMap,
                "same_net_via_spacing",
                "all",
                viaA.objectId,
                viaB.objectId,
                drillGap,
                minDrillClearance,
              );
            }
          } else if (drillGap < minDrillClearance - DRC_GAP_EPSILON) {
            upsertViolation(
              violationsMap,
              "via_drill_spacing",
              "all",
              viaA.objectId,
              viaB.objectId,
              drillGap,
              minDrillClearance,
            );
          }
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    unsupportedReasons.push(message);
    upsertViolation(
      violationsMap,
      "unsupported_geometry",
      "all",
      "board:exception",
      "board:exception",
      -1,
      0,
      `DRC signature failed closed: ${message}`,
    );
  }

  return finalizeSignature(
    violationsMap,
    unsupportedReasons,
    traces,
    forceSnapshotKey,
  );
}

function finalizeSignature(
  violationsMap: Map<string, SrjBoardDrcViolation>,
  unsupportedReasons: string[],
  traces: readonly SimplifiedPcbTrace[],
  forceSnapshotKey: boolean,
): SrjBoardDrcSignature {
  const violations = [...violationsMap.values()].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const orderedMap = new Map<string, SrjBoardDrcViolation>();
  const violationCountByKind = buildEmptyCountByKind();
  for (const violation of violations) {
    orderedMap.set(violation.id, violation);
    violationCountByKind[violation.kind]++;
  }
  const hasUnsupportedGeometry = violationCountByKind.unsupported_geometry > 0;
  const traceSnapshotKey =
    hasUnsupportedGeometry || forceSnapshotKey ? stableSerialize(traces) : "";

  return {
    violationsById: orderedMap,
    violations,
    violationCountByKind,
    hasUnsupportedGeometry,
    unsupportedGeometryReasons: unsupportedReasons,
    traceSnapshotKey,
  };
}

/**
 * Computes a deterministic whole-board SRJ DRC signature at phase boundaries.
 *
 * Violations are keyed by canonical `(kind, layerScope, sortedPair(objectIdA, objectIdB))`
 * rather than aggregate counts, with exact signed edge-to-edge gaps (`< 0` on overlap).
 * Unsupported or malformed legal SRJ geometry never throws and instead emits a
 * fail-closed `unsupported_geometry` violation entry.
 */
export function computeSrjBoardDrcSignature(
  simpleRouteJson: SimpleRouteJson,
  traces: readonly SimplifiedPcbTrace[] = simpleRouteJson?.traces ?? [],
): SrjBoardDrcSignature {
  const context = buildStaticBoardDrcContext(simpleRouteJson, traces);
  return evaluateSignatureWithContext(context, traces, false);
}

/**
 * Compares a candidate SRJ DRC signature against a validated baseline signature.
 *
 * Enforces strict per-identity subset and gap monotonicity:
 * 1. Any violation identity present in `candidate` but absent in `baseline` is rejected
 *    (preventing equal-count violation swaps from hiding newly introduced defects).
 * 2. Any violation identity remaining from `baseline` must satisfy
 *    `candidate.gap + DRC_GAP_EPSILON >= baseline.gap`.
 * 3. Boards with unsupported geometry fail closed on any trace mutation.
 */
export function compareSrjBoardDrcSignatures(
  baseline: SrjBoardDrcSignature,
  candidate: SrjBoardDrcSignature,
): SrjBoardDrcComparison {
  const newViolations: SrjBoardDrcViolation[] = [];
  const worsenedViolations: Array<{
    baseline: SrjBoardDrcViolation;
    candidate: SrjBoardDrcViolation;
  }> = [];
  const resolvedViolationIds: string[] = [];
  const regressions: SrjBoardDrcRegression[] = [];

  for (const candViolation of candidate.violations) {
    const baseViolation = baseline.violationsById.get(candViolation.id);
    if (!baseViolation) {
      newViolations.push(candViolation);
      regressions.push({
        reason:
          candViolation.kind === "unsupported_geometry"
            ? "unsupported_geometry"
            : "new_violation",
        id: candViolation.id,
        kind: candViolation.kind,
        layerScope: candViolation.layerScope,
        objectIdA: candViolation.objectIdA,
        objectIdB: candViolation.objectIdB,
        baselineGap: null,
        candidateGap: candViolation.gap,
        requiredGap: candViolation.requiredGap,
        detail: candViolation.detail,
      });
      continue;
    }

    if (candViolation.gap + DRC_GAP_EPSILON < baseViolation.gap) {
      worsenedViolations.push({
        baseline: baseViolation,
        candidate: candViolation,
      });
      regressions.push({
        reason: "worsened_gap",
        id: candViolation.id,
        kind: candViolation.kind,
        layerScope: candViolation.layerScope,
        objectIdA: candViolation.objectIdA,
        objectIdB: candViolation.objectIdB,
        baselineGap: baseViolation.gap,
        candidateGap: candViolation.gap,
        requiredGap: candViolation.requiredGap,
        detail: candViolation.detail,
      });
    }
  }

  for (const baseId of baseline.violationsById.keys()) {
    if (!candidate.violationsById.has(baseId)) {
      resolvedViolationIds.push(baseId);
    }
  }

  if (
    (baseline.hasUnsupportedGeometry || candidate.hasUnsupportedGeometry) &&
    candidate.traceSnapshotKey !== baseline.traceSnapshotKey &&
    !regressions.some(
      (regression) => regression.reason === "unsupported_geometry",
    )
  ) {
    const detail =
      candidate.unsupportedGeometryReasons[0] ??
      baseline.unsupportedGeometryReasons[0] ??
      "Board contains unsupported geometry; mutations fail closed to exact trace preservation";
    regressions.push({
      reason: "unsupported_geometry",
      id: "unsupported_geometry|all|board:fail_closed|board:fail_closed",
      kind: "unsupported_geometry",
      layerScope: "all",
      objectIdA: "board:fail_closed",
      objectIdB: "board:fail_closed",
      baselineGap: -1,
      candidateGap: -1,
      requiredGap: 0,
      detail,
    });
  }

  return {
    safe: regressions.length === 0,
    newViolations,
    worsenedViolations,
    resolvedViolationIds,
    regressions,
  };
}

export class SrjBoardDrcCertificate {
  readonly inputProblem: SimpleRouteJson;
  readonly initialSignature: SrjBoardDrcSignature;
  baseline: SrjBoardDrcSignature;
  private readonly context: StaticBoardDrcContext;

  constructor(
    inputProblem: SimpleRouteJson,
    initialTraces: readonly SimplifiedPcbTrace[] = inputProblem?.traces ?? [],
    connectionNameResolver?: ConnectionNameResolver,
  ) {
    this.inputProblem = inputProblem;
    this.context = buildStaticBoardDrcContext(
      inputProblem,
      initialTraces,
      connectionNameResolver,
    );
    this.initialSignature = evaluateSignatureWithContext(
      this.context,
      initialTraces,
      false,
    );
    this.baseline = this.initialSignature;
  }

  computeSignature(
    traces: readonly SimplifiedPcbTrace[],
    forceSnapshotKey = this.baseline.hasUnsupportedGeometry,
  ): SrjBoardDrcSignature {
    return evaluateSignatureWithContext(this.context, traces, forceSnapshotKey);
  }

  validate(
    candidateTraces: readonly SimplifiedPcbTrace[],
    baselineSignature: SrjBoardDrcSignature = this.baseline,
  ): SrjBoardDrcValidation {
    const candidate = this.computeSignature(
      candidateTraces,
      baselineSignature.hasUnsupportedGeometry,
    );
    const comparison = compareSrjBoardDrcSignatures(
      baselineSignature,
      candidate,
    );
    return {
      safe: comparison.safe,
      baseline: baselineSignature,
      candidate,
      comparison,
    };
  }

  accept(candidateSignature: SrjBoardDrcSignature): void {
    this.baseline = candidateSignature;
  }
}
