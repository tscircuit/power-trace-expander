import type { SimpleRouteJson, SimplifiedPcbTrace } from "@tscircuit/core";

export type Point = { x: number; y: number };

export type WireRoutePoint = Extract<
  SimplifiedPcbTrace["route"][number],
  { route_type: "wire" }
>;

export type PowerTraceExpanderInput = SimpleRouteJson;

export type PowerTraceExpanderOutput = SimplifiedPcbTrace[];

export type IndexedObstacle = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  layers: string[];
  kind: "obstacle" | "trace" | "via";
  connectionNames: string[];
  traceIndex?: number;
  routeStartIndex?: number;
  routeEndIndex?: number;
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
  ignoreRouteRange?: { start: number; end: number };
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
};

export type GridRouteOutput = {
  points: Point[];
  traceWidth: number;
  gridSize: number;
  gridOffset: GridOffset;
};
