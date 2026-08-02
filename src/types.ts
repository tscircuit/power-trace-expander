export type WireRoutePoint = {
  route_type: "wire";
  x: number;
  y: number;
  width: number;
  layer: string;
  start_pcb_port_id?: string;
  end_pcb_port_id?: string;
};

export type ViaRoutePoint = {
  route_type: "via";
  x: number;
  y: number;
  to_layer: string;
  from_layer: string;
  via_diameter?: number;
  via_hole_diameter?: number;
};

export type SimplifiedPcbTrace = {
  type: "pcb_trace";
  pcb_trace_id: string;
  connection_name?: string;
  source_trace_id?: string;
  rootConnectionName?: string;
  mergedConnectionNames?: string[];
  connectsTo?: string[];
  route: Array<
    | WireRoutePoint
    | ViaRoutePoint
    | {
        route_type: "jumper";
        start: Point;
        end: Point;
        footprint: "0603" | "1206" | "1206x4_pair";
        layer: string;
      }
    | {
        route_type: "through_obstacle";
        start: Point;
        end: Point;
        from_layer: string;
        to_layer: string;
        width: number;
      }
  >;
};

export type SimpleRouteConnection = {
  name: string;
  source_trace_id?: string;
  rootConnectionName?: string;
  mergedConnectionNames?: string[];
  isOffBoard?: boolean;
  netConnectionName?: string;
  nominalTraceWidth?: number;
  width?: number;
  pointsToConnect: Array<
    Point & {
      layer: string;
      layers?: string[];
      pointId?: string;
      pcb_port_id?: string;
    }
  >;
};

export type Obstacle = {
  obstacleId?: string;
  componentId?: string;
  type: "rect";
  layers: string[];
  zLayers?: number[];
  center: Point;
  width: number;
  height: number;
  ccwRotationDegrees?: number;
  connectedTo: string[];
  isCopperPour?: boolean;
  netIsAssignable?: boolean;
  offBoardConnectsTo?: string[];
};

export type SimpleRouteJson = {
  layerCount: number;
  minTraceWidth: number;
  nominalTraceWidth?: number;
  minViaDiameter?: number;
  minViaHoleDiameter?: number;
  minViaPadDiameter?: number;
  min_via_hole_diameter?: number;
  min_via_pad_diameter?: number;
  defaultObstacleMargin?: number;
  minTraceToPadEdgeClearance?: number;
  minBoardEdgeClearance?: number;
  minViaHoleEdgeToViaHoleEdgeClearance?: number;
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
  connections: SimpleRouteConnection[];
  obstacles: Obstacle[];
  traces?: SimplifiedPcbTrace[];
  /** Immutable routed copper that participates in clearance checks only. */
  fixedTraces?: SimplifiedPcbTrace[];
};

export type Point = { x: number; y: number };

export type CopperRoutePoint = WireRoutePoint | ViaRoutePoint;

export type PowerTraceExpanderInput = SimpleRouteJson;

export type PowerTraceExpanderOptions = {
  /** Restrict the top-level scan while still allowing nearby traces to move. */
  onlyConnectionNames?: readonly string[];
  /**
   * Preferred edge clearance from power copper to unrelated pads. Defaults
   * to half of each power trace's nominal width.
   */
  powerTraceToPadClearance?: number;
};

export type PowerTraceExpanderOutput = SimplifiedPcbTrace[];

export type PowerTraceCleanupProblem = {
  simpleRouteJson: SimpleRouteJson;
  traces: SimplifiedPcbTrace[];
  /** Restrict cleanup to these traces while retaining all traces as obstacles. */
  traceIndices?: readonly number[];
  maxRerouteLength?: number;
  clearancePaddingTiers?: readonly number[];
  /** Defaults to half of each power trace's nominal width. */
  desiredPadClearance?: number;
};

export type PowerTraceCleanupOutput = SimplifiedPcbTrace[];

export type IndexedObstacle = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  layers: string[];
  kind: "obstacle" | "trace" | "via";
  obstacleKind?: "pad" | "via" | "other";
  connectionNames: string[];
  traceIndex?: number;
  routeStartIndex?: number;
  routeEndIndex?: number;
  viaHoleDiameter?: number;
  exactShape?:
    | { type: "segment"; start: Point; end: Point; width: number }
    | { type: "polygon"; points: Point[] }
    | { type: "circle"; center: Point; radius: number };
};

export type CollisionQuery = {
  start: Point;
  end: Point;
  layer: string;
  width: number;
  connectionNames: string[];
  ignoreTraceIndex?: number;
  ignoreTraceIndices?: readonly number[];
  ignoreRouteRange?: { start: number; end: number };
  /** Override trace-to-pad clearance without widening trace spacing. */
  obstacleClearance?: number;
  /** Prospective vias use this to stay out of connected pads as a DFM rule. */
  blockSameNetObstacles?: boolean;
  /** Optional mechanical spacing for connected pads when they are blocked. */
  sameNetObstacleClearance?: number;
};

export type ViaCollisionQuery = {
  point: Point;
  layers: string[];
  padDiameter: number;
  holeDiameter: number;
  connectionNames: string[];
  ignoreTraceIndex?: number;
  ignoreTraceIndices?: readonly number[];
  ignoreRouteRange?: { start: number; end: number };
  obstacleClearance?: number;
  blockSameNetObstacles?: boolean;
  sameNetObstacleClearance?: number;
  otherNewViaPoints?: Point[];
  fixedVias?: Array<{
    point: Point;
    padDiameter: number;
    holeDiameter: number;
  }>;
};

export type InflationCorridorSegment = {
  start: Point;
  end: Point;
  layer: string;
  width: number;
};

export type LocalTraceInflationProblem = {
  simpleRouteJson: SimpleRouteJson;
  traces: SimplifiedPcbTrace[];
  powerTraceIndex: number;
  nominalPowerWidth: number;
  /** Do not shove traces at or above this electrical nominal width. */
  pushOnlyNominalWidthsBelow?: number;
  corridor: InflationCorridorSegment[];
  maxRerouteLength?: number;
};

export type LocalTraceInflationOutput = {
  traces: SimplifiedPcbTrace[];
  pushedTraceIndex: number;
  replacedRange: { startIndex: number; endIndex: number };
  strategy: "elastic" | "grid";
};

export type ElasticTracePushProblem = {
  trace: SimplifiedPcbTrace;
  range: { startIndex: number; endIndex: number };
  layer: string;
  traceWidth: number;
  corridor: InflationCorridorSegment[];
  obstacleIndex: import("./SpatialObstacleIndex").SpatialObstacleIndex;
  connectionNames: string[];
};

export type ElasticTracePushOutput = {
  points: Point[];
  traceWidth: number;
};

export type GridOffset = { x: number; y: number };

export type GridRouteProblem = {
  start: Point;
  end: Point;
  layer: string;
  traceWidth: number;
  gridSize: number;
  gridOffset: GridOffset;
  connectionNames: string[];
  obstacleIndex: import("./SpatialObstacleIndex").SpatialObstacleIndex;
  ignoreTraceIndex: number;
  ignoreRouteRange: { start: number; end: number };
  bounds: SimpleRouteJson["bounds"];
  searchPadding: number;
  /** Keep the reconstructed route on 0/45/90-degree headings. */
  requireOctilinear?: boolean;
  obstacleClearance?: number;
};

export type GridRouteOutput = {
  points: Point[];
  traceWidth: number;
  gridSize: number;
  gridOffset: GridOffset;
};

export type LayerGridRouteProblem = {
  start: Point;
  end: Point;
  originalStartLayer: string;
  originalEndLayer: string;
  startLayers: string[];
  endLayers: string[];
  layers: string[];
  traceWidth: number;
  startNeckWidth: number;
  endNeckWidth: number;
  maxStartNeckLength: number;
  maxEndNeckLength: number;
  neckPenaltyExponent: number;
  viaDiameter: number;
  viaHoleDiameter: number;
  minViaCount: number;
  maxViaCount: number;
  viaCost: number;
  gridSize: number;
  gridOffset: GridOffset;
  connectionNames: string[];
  obstacleIndex: import("./SpatialObstacleIndex").SpatialObstacleIndex;
  ignoreTraceIndex: number;
  ignoreRouteRange: { start: number; end: number };
  softTraceIndices: number[];
  fixedVias: NonNullable<ViaCollisionQuery["fixedVias"]>;
  bounds: SimpleRouteJson["bounds"];
  searchPadding: number;
  obstacleClearance?: number;
};

export type LayerGridRouteOutput = {
  route: CopperRoutePoint[];
  traceWidth: number;
  startNeckWidth: number;
  endNeckWidth: number;
  gridSize: number;
  gridOffset: GridOffset;
  viaCount: number;
};
