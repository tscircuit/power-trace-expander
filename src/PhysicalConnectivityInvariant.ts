import Flatbush from "flatbush";
import { ConnectionNameResolver } from "./ConnectionNameResolver";
import type {
  Obstacle,
  Point,
  PowerTraceExpanderInput,
  SimpleRouteConnection,
  SimplifiedPcbTrace,
  ViaRoutePoint,
  WireRoutePoint,
} from "./types";

const GEOMETRY_EPSILON_MM = 1e-6;

type Bounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

type EndpointPrimitive = {
  kind: "endpoint";
  endpointKey: string;
  endpointLabel: string;
  point: Point;
  layers: string[];
  bounds: Bounds;
};

type ObstaclePrimitive = {
  kind: "obstacle";
  obstacle: Obstacle;
  layers: string[];
  bounds: Bounds;
};

type SegmentPrimitive = {
  kind: "segment";
  start: Point;
  end: Point;
  width: number;
  layers: string[];
  bounds: Bounds;
};

type ViaPrimitive = {
  kind: "via";
  center: Point;
  diameter: number;
  layers: string[];
  bounds: Bounds;
};

type BridgeContactPrimitive = {
  kind: "bridge-contact";
  center: Point;
  diameter: number;
  layers: string[];
  bridgeId: string;
  bounds: Bounds;
};

type BridgePadPrimitive = {
  kind: "bridge-pad";
  obstacle: Obstacle;
  layers: string[];
  bridgeId: string;
  bounds: Bounds;
};

type CopperPrimitive =
  | EndpointPrimitive
  | ObstaclePrimitive
  | SegmentPrimitive
  | ViaPrimitive
  | BridgeContactPrimitive
  | BridgePadPrimitive;

export type PhysicalConnectivitySnapshot = {
  endpointCount: number;
  endpointLabels: Record<string, string>;
  componentByEndpointKey: Record<string, string>;
  endpointComponents: string[][];
};

export type PhysicalConnectivityRegression = {
  baselineEndpointKeys: string[];
  baselineEndpointLabels: string[];
  candidateComponents: string[][];
};

export type PhysicalConnectivityValidation = {
  safe: boolean;
  candidate: PhysicalConnectivitySnapshot;
  regressions: PhysicalConnectivityRegression[];
  validationError?: string;
};

const distance = (first: Point, second: Point) =>
  Math.hypot(first.x - second.x, first.y - second.y);

const distancePointToSegment = (point: Point, start: Point, end: Point) => {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  const position =
    lengthSquared <= GEOMETRY_EPSILON_MM * GEOMETRY_EPSILON_MM
      ? 0
      : Math.max(
          0,
          Math.min(
            1,
            ((point.x - start.x) * dx + (point.y - start.y) * dy) /
              lengthSquared,
          ),
        );
  return Math.hypot(
    point.x - (start.x + position * dx),
    point.y - (start.y + position * dy),
  );
};

const crossProduct = (origin: Point, first: Point, second: Point) =>
  (first.x - origin.x) * (second.y - origin.y) -
  (first.y - origin.y) * (second.x - origin.x);

const segmentsProperlyCross = (
  firstStart: Point,
  firstEnd: Point,
  secondStart: Point,
  secondEnd: Point,
) => {
  const firstDirection = crossProduct(secondStart, secondEnd, firstStart);
  const secondDirection = crossProduct(secondStart, secondEnd, firstEnd);
  const thirdDirection = crossProduct(firstStart, firstEnd, secondStart);
  const fourthDirection = crossProduct(firstStart, firstEnd, secondEnd);
  return (
    ((firstDirection > 0 && secondDirection < 0) ||
      (firstDirection < 0 && secondDirection > 0)) &&
    ((thirdDirection > 0 && fourthDirection < 0) ||
      (thirdDirection < 0 && fourthDirection > 0))
  );
};

const distanceSegmentToSegment = (
  firstStart: Point,
  firstEnd: Point,
  secondStart: Point,
  secondEnd: Point,
) => {
  if (segmentsProperlyCross(firstStart, firstEnd, secondStart, secondEnd)) {
    return 0;
  }
  return Math.min(
    distancePointToSegment(firstStart, secondStart, secondEnd),
    distancePointToSegment(firstEnd, secondStart, secondEnd),
    distancePointToSegment(secondStart, firstStart, firstEnd),
    distancePointToSegment(secondEnd, firstStart, firstEnd),
  );
};

const getObstaclePolygon = (obstacle: Obstacle): Point[] => {
  const angle = ((obstacle.ccwRotationDegrees ?? 0) * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [
    { x: -obstacle.width / 2, y: -obstacle.height / 2 },
    { x: obstacle.width / 2, y: -obstacle.height / 2 },
    { x: obstacle.width / 2, y: obstacle.height / 2 },
    { x: -obstacle.width / 2, y: obstacle.height / 2 },
  ].map((point) => ({
    x: obstacle.center.x + point.x * cos - point.y * sin,
    y: obstacle.center.y + point.x * sin + point.y * cos,
  }));
};

const obstacleIsCircular = (obstacle: Obstacle) => {
  const hasCircularShape =
    obstacle.type === "oval" ||
    (obstacle as Obstacle & { shape?: string }).shape === "circle";
  if (!hasCircularShape) return false;
  if (Math.abs(obstacle.width - obstacle.height) > GEOMETRY_EPSILON_MM) {
    throw new Error(
      `Physical connectivity does not yet support non-circular oval obstacle ${obstacle.obstacleId ?? "<unknown>"}`,
    );
  }
  return true;
};

const pointIsInsidePolygon = (point: Point, polygon: Point[]) => {
  for (let index = 0; index < polygon.length; index++) {
    if (
      distancePointToSegment(
        point,
        polygon[index]!,
        polygon[(index + 1) % polygon.length]!,
      ) <= GEOMETRY_EPSILON_MM
    ) {
      return true;
    }
  }

  let inside = false;
  for (
    let currentIndex = 0, previousIndex = polygon.length - 1;
    currentIndex < polygon.length;
    previousIndex = currentIndex++
  ) {
    const current = polygon[currentIndex]!;
    const previous = polygon[previousIndex]!;
    const crossesRay =
      current.y > point.y !== previous.y > point.y &&
      point.x <
        ((previous.x - current.x) * (point.y - current.y)) /
          (previous.y - current.y) +
          current.x;
    if (crossesRay) inside = !inside;
  }
  return inside;
};

const distancePointToObstacle = (point: Point, obstacle: Obstacle) => {
  if (obstacleIsCircular(obstacle)) {
    return Math.max(0, distance(point, obstacle.center) - obstacle.width / 2);
  }
  const polygon = getObstaclePolygon(obstacle);
  if (pointIsInsidePolygon(point, polygon)) return 0;
  return Math.min(
    ...polygon.map((corner, index) =>
      distancePointToSegment(
        point,
        corner,
        polygon[(index + 1) % polygon.length]!,
      ),
    ),
  );
};

const distanceSegmentToObstacle = (
  start: Point,
  end: Point,
  obstacle: Obstacle,
) => {
  if (obstacleIsCircular(obstacle)) {
    return Math.max(
      0,
      distancePointToSegment(obstacle.center, start, end) - obstacle.width / 2,
    );
  }
  const polygon = getObstaclePolygon(obstacle);
  if (
    pointIsInsidePolygon(start, polygon) ||
    pointIsInsidePolygon(end, polygon)
  ) {
    return 0;
  }
  return Math.min(
    ...polygon.map((corner, index) =>
      distanceSegmentToSegment(
        start,
        end,
        corner,
        polygon[(index + 1) % polygon.length]!,
      ),
    ),
  );
};

const distanceObstacleToObstacle = (first: Obstacle, second: Obstacle) => {
  if (obstacleIsCircular(first)) {
    if (obstacleIsCircular(second)) {
      return Math.max(
        0,
        distance(first.center, second.center) -
          first.width / 2 -
          second.width / 2,
      );
    }
    return Math.max(
      0,
      distancePointToObstacle(first.center, second) - first.width / 2,
    );
  }
  if (obstacleIsCircular(second)) {
    return distanceObstacleToObstacle(second, first);
  }

  const firstPolygon = getObstaclePolygon(first);
  const secondPolygon = getObstaclePolygon(second);
  if (
    pointIsInsidePolygon(firstPolygon[0]!, secondPolygon) ||
    pointIsInsidePolygon(secondPolygon[0]!, firstPolygon)
  ) {
    return 0;
  }
  let minimumDistance = Number.POSITIVE_INFINITY;
  for (let firstIndex = 0; firstIndex < firstPolygon.length; firstIndex++) {
    for (
      let secondIndex = 0;
      secondIndex < secondPolygon.length;
      secondIndex++
    ) {
      minimumDistance = Math.min(
        minimumDistance,
        distanceSegmentToSegment(
          firstPolygon[firstIndex]!,
          firstPolygon[(firstIndex + 1) % firstPolygon.length]!,
          secondPolygon[secondIndex]!,
          secondPolygon[(secondIndex + 1) % secondPolygon.length]!,
        ),
      );
    }
  }
  return minimumDistance;
};

const expandBounds = (bounds: Bounds, amount: number): Bounds => ({
  minX: bounds.minX - amount,
  minY: bounds.minY - amount,
  maxX: bounds.maxX + amount,
  maxY: bounds.maxY + amount,
});

const getPointBounds = (point: Point): Bounds => ({
  minX: point.x,
  minY: point.y,
  maxX: point.x,
  maxY: point.y,
});

const getObstacleBounds = (obstacle: Obstacle): Bounds => {
  if (obstacleIsCircular(obstacle)) {
    return expandBounds(getPointBounds(obstacle.center), obstacle.width / 2);
  }
  const polygon = getObstaclePolygon(obstacle);
  return {
    minX: Math.min(...polygon.map((point) => point.x)),
    minY: Math.min(...polygon.map((point) => point.y)),
    maxX: Math.max(...polygon.map((point) => point.x)),
    maxY: Math.max(...polygon.map((point) => point.y)),
  };
};

const boundsTouch = (first: Bounds, second: Bounds) =>
  first.maxX + GEOMETRY_EPSILON_MM >= second.minX &&
  second.maxX + GEOMETRY_EPSILON_MM >= first.minX &&
  first.maxY + GEOMETRY_EPSILON_MM >= second.minY &&
  second.maxY + GEOMETRY_EPSILON_MM >= first.minY;

const shareLayer = (first: CopperPrimitive, second: CopperPrimitive) =>
  first.layers.some((layer) => second.layers.includes(layer));

const primitivesTouch = (first: CopperPrimitive, second: CopperPrimitive) => {
  if (!shareLayer(first, second) || !boundsTouch(first.bounds, second.bounds)) {
    return false;
  }

  if (first.kind === "bridge-pad") {
    const obstaclePrimitive: ObstaclePrimitive = {
      kind: "obstacle",
      obstacle: first.obstacle,
      layers: first.layers,
      bounds: first.bounds,
    };
    if (second.kind === "bridge-pad") {
      return primitivesTouch(obstaclePrimitive, {
        kind: "obstacle",
        obstacle: second.obstacle,
        layers: second.layers,
        bounds: second.bounds,
      });
    }
    return primitivesTouch(obstaclePrimitive, second);
  }
  if (second.kind === "bridge-pad") return primitivesTouch(second, first);

  if (first.kind === "endpoint") {
    if (second.kind === "endpoint") {
      return distance(first.point, second.point) <= GEOMETRY_EPSILON_MM;
    }
    if (second.kind === "obstacle") {
      return (
        distancePointToObstacle(first.point, second.obstacle) <=
        GEOMETRY_EPSILON_MM
      );
    }
    if (second.kind === "segment") {
      return (
        distancePointToSegment(first.point, second.start, second.end) <=
        second.width / 2 + GEOMETRY_EPSILON_MM
      );
    }
    return (
      distance(first.point, second.center) <=
      second.diameter / 2 + GEOMETRY_EPSILON_MM
    );
  }
  if (second.kind === "endpoint") return primitivesTouch(second, first);

  if (first.kind === "obstacle") {
    if (second.kind === "obstacle") {
      return (
        distanceObstacleToObstacle(first.obstacle, second.obstacle) <=
        GEOMETRY_EPSILON_MM
      );
    }
    if (second.kind === "segment") {
      return (
        distanceSegmentToObstacle(second.start, second.end, first.obstacle) <=
        second.width / 2 + GEOMETRY_EPSILON_MM
      );
    }
    return (
      distancePointToObstacle(second.center, first.obstacle) <=
      second.diameter / 2 + GEOMETRY_EPSILON_MM
    );
  }
  if (second.kind === "obstacle") return primitivesTouch(second, first);

  if (first.kind === "segment") {
    if (second.kind === "segment") {
      return (
        distanceSegmentToSegment(
          first.start,
          first.end,
          second.start,
          second.end,
        ) <=
        (first.width + second.width) / 2 + GEOMETRY_EPSILON_MM
      );
    }
    return (
      distancePointToSegment(second.center, first.start, first.end) <=
      first.width / 2 + second.diameter / 2 + GEOMETRY_EPSILON_MM
    );
  }
  if (second.kind === "segment") return primitivesTouch(second, first);

  return (
    distance(first.center, second.center) <=
    (first.diameter + second.diameter) / 2 + GEOMETRY_EPSILON_MM
  );
};

class DisjointSet {
  private readonly parent: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, index) => index);
  }

  find(index: number): number {
    const parent = this.parent[index]!;
    if (parent === index) return index;
    const root = this.find(parent);
    this.parent[index] = root;
    return root;
  }

  union(first: number, second: number) {
    const firstRoot = this.find(first);
    const secondRoot = this.find(second);
    if (firstRoot !== secondRoot) this.parent[secondRoot] = firstRoot;
  }
}

const getBoardLayers = (layerCount: number) => {
  if (layerCount <= 1) return ["top"];
  if (layerCount === 2) return ["top", "bottom"];
  return [
    "top",
    ...Array.from(
      { length: layerCount - 2 },
      (_, index) => `inner${index + 1}`,
    ),
    "bottom",
  ];
};

const getViaLayers = (via: ViaRoutePoint, boardLayers: string[]) => {
  const fromIndex = boardLayers.indexOf(via.from_layer);
  const toIndex = boardLayers.indexOf(via.to_layer);
  if (fromIndex < 0 || toIndex < 0) {
    return [...new Set([via.from_layer, via.to_layer])];
  }
  return boardLayers.slice(
    Math.min(fromIndex, toIndex),
    Math.max(fromIndex, toIndex) + 1,
  );
};

const getTraceConnectionNames = (trace: SimplifiedPcbTrace) =>
  [
    trace.pcb_trace_id,
    trace.connection_name,
    trace.source_trace_id,
    trace.rootConnectionName,
    ...(trace.mergedConnectionNames ?? []),
    ...(trace.connectsTo ?? []),
  ].filter((name): name is string => Boolean(name));

const getConnectionNames = (connection: SimpleRouteConnection) =>
  [
    connection.name,
    connection.source_trace_id,
    connection.rootConnectionName,
    ...(connection.mergedConnectionNames ?? []),
    connection.netConnectionName,
    ...connection.pointsToConnect.flatMap((point) => [
      point.pointId,
      point.pcb_port_id,
    ]),
  ].filter((name): name is string => Boolean(name));

const getObstacleConnectionNames = (obstacle: Obstacle) =>
  [
    obstacle.obstacleId,
    ...obstacle.connectedTo,
    ...(obstacle.offBoardConnectsTo ?? []),
  ].filter((name): name is string => Boolean(name));

const getDefaultViaDiameter = (inputProblem: PowerTraceExpanderInput) => {
  const holeDiameter =
    inputProblem.min_via_hole_diameter ?? inputProblem.minViaHoleDiameter ?? 0;
  return Math.max(
    holeDiameter,
    inputProblem.min_via_pad_diameter ??
      inputProblem.minViaPadDiameter ??
      inputProblem.minViaDiameter ??
      0.6,
  );
};

const createBridgeContact = (
  point: Point,
  diameter: number,
  layers: string[],
  bridgeId: string,
): BridgeContactPrimitive => ({
  kind: "bridge-contact",
  center: { x: point.x, y: point.y },
  diameter,
  layers,
  bridgeId,
  bounds: expandBounds(getPointBounds(point), diameter / 2),
});

const JUMPER_ENDPOINT_TOLERANCE_MM = 0.01;
const JUMPER_PAD_DIMENSIONS: Record<
  "0603" | "1206" | "1206x4_pair",
  {
    horizontalWidth: number;
    horizontalHeight: number;
    centerSpacings: number[];
  }
> = {
  "0603": {
    horizontalWidth: 0.8,
    horizontalHeight: 0.95,
    // Current and legacy capacity-router emitters disagree on this spacing.
    centerSpacings: [1.65, 1.8],
  },
  "1206": {
    horizontalWidth: 0.6,
    horizontalHeight: 1.6,
    centerSpacings: [3.2],
  },
  "1206x4_pair": {
    horizontalWidth: 0.8,
    horizontalHeight: 0.5,
    centerSpacings: [2.7],
  },
};

type JumperRoutePoint = Extract<
  SimplifiedPcbTrace["route"][number],
  { route_type: "jumper" }
>;

const createJumperPad = (
  jumper: JumperRoutePoint,
  center: Point,
  bridgeId: string,
): BridgePadPrimitive => {
  if (!jumper.layer) throw new Error(`Jumper ${bridgeId} is missing its layer`);
  const dimensions = JUMPER_PAD_DIMENSIONS[jumper.footprint];
  if (!dimensions) {
    throw new Error(
      `Unsupported jumper footprint ${String(jumper.footprint)} on ${bridgeId}`,
    );
  }
  const deltaX = Math.abs(jumper.end.x - jumper.start.x);
  const deltaY = Math.abs(jumper.end.y - jumper.start.y);
  const hasExpectedSpacing = (spacing: number) =>
    dimensions.centerSpacings.some(
      (candidate) =>
        Math.abs(spacing - candidate) < JUMPER_ENDPOINT_TOLERANCE_MM,
    );
  const horizontal =
    deltaY < JUMPER_ENDPOINT_TOLERANCE_MM && hasExpectedSpacing(deltaX);
  const vertical =
    deltaX < JUMPER_ENDPOINT_TOLERANCE_MM && hasExpectedSpacing(deltaY);
  if (!horizontal && !vertical) {
    throw new Error(
      `Jumper ${bridgeId} does not match ${jumper.footprint} pad spacing`,
    );
  }
  const obstacle: Obstacle = {
    type: "rect",
    center: { ...center },
    width: horizontal
      ? dimensions.horizontalWidth
      : dimensions.horizontalHeight,
    height: horizontal
      ? dimensions.horizontalHeight
      : dimensions.horizontalWidth,
    layers: [jumper.layer],
    connectedTo: [],
  };
  return {
    kind: "bridge-pad",
    obstacle,
    layers: obstacle.layers,
    bridgeId,
    bounds: getObstacleBounds(obstacle),
  };
};

const wireSegmentMatchesJumper = (
  start: WireRoutePoint,
  end: WireRoutePoint,
  jumper: JumperRoutePoint,
) => {
  if (start.layer !== jumper.layer || end.layer !== jumper.layer) return false;
  const pointMatches = (first: Point, second: Point) =>
    Math.abs(first.x - second.x) < JUMPER_ENDPOINT_TOLERANCE_MM &&
    Math.abs(first.y - second.y) < JUMPER_ENDPOINT_TOLERANCE_MM;
  const forward =
    pointMatches(start, jumper.start) && pointMatches(end, jumper.end);
  const reverse =
    pointMatches(start, jumper.end) && pointMatches(end, jumper.start);
  return forward || reverse;
};

const extractTraceCopper = (
  trace: SimplifiedPcbTrace,
  boardLayers: string[],
  defaultViaDiameter: number,
  sameNetObstacles: Obstacle[],
): Array<
  SegmentPrimitive | ViaPrimitive | BridgeContactPrimitive | BridgePadPrimitive
> => {
  const primitives: Array<
    | SegmentPrimitive
    | ViaPrimitive
    | BridgeContactPrimitive
    | BridgePadPrimitive
  > = [];
  const jumpers = trace.route.flatMap((routePoint, routePointIndex) =>
    routePoint.route_type === "jumper" ? [{ routePoint, routePointIndex }] : [],
  );
  const jumperByWireEndIndex = new Map<number, (typeof jumpers)[number]>();
  for (const jumper of jumpers) {
    const matchingWireEndIndices: number[] = [];
    for (let routeIndex = 1; routeIndex < trace.route.length; routeIndex++) {
      const start = trace.route[routeIndex - 1];
      const end = trace.route[routeIndex];
      if (
        start?.route_type === "wire" &&
        end?.route_type === "wire" &&
        wireSegmentMatchesJumper(start, end, jumper.routePoint)
      ) {
        matchingWireEndIndices.push(routeIndex);
      }
    }
    if (matchingWireEndIndices.length !== 1) {
      throw new Error(
        `Jumper ${trace.pcb_trace_id}:${jumper.routePointIndex} matched ${matchingWireEndIndices.length} placeholder wire segments`,
      );
    }
    const wireEndIndex = matchingWireEndIndices[0]!;
    if (jumperByWireEndIndex.has(wireEndIndex)) {
      throw new Error(
        `Multiple jumpers matched placeholder segment ${wireEndIndex} on ${trace.pcb_trace_id}`,
      );
    }
    jumperByWireEndIndex.set(wireEndIndex, jumper);
  }
  let previousWire: WireRoutePoint | undefined;
  for (
    let routePointIndex = 0;
    routePointIndex < trace.route.length;
    routePointIndex++
  ) {
    const routePoint = trace.route[routePointIndex]!;
    if (routePoint.route_type === "wire") {
      if (
        previousWire &&
        previousWire.layer === routePoint.layer &&
        distance(previousWire, routePoint) > GEOMETRY_EPSILON_MM
      ) {
        const segmentStart = previousWire;
        const jumper = jumperByWireEndIndex.get(routePointIndex);
        if (jumper) {
          // Capacity autorouter serializes a jumper as a placeholder wire plus
          // appended metadata. The body is insulated and must not participate
          // in PCB copper contacts.
        } else {
          const radius = segmentStart.width / 2;
          primitives.push({
            kind: "segment",
            start: { x: segmentStart.x, y: segmentStart.y },
            end: { x: routePoint.x, y: routePoint.y },
            width: segmentStart.width,
            layers: [segmentStart.layer],
            bounds: expandBounds(
              {
                minX: Math.min(segmentStart.x, routePoint.x),
                minY: Math.min(segmentStart.y, routePoint.y),
                maxX: Math.max(segmentStart.x, routePoint.x),
                maxY: Math.max(segmentStart.y, routePoint.y),
              },
              radius,
            ),
          });
        }
      }
      previousWire = routePoint;
      continue;
    }
    previousWire = undefined;
    if (routePoint.route_type === "via") {
      const previousRoutePoint = trace.route[routePointIndex - 1];
      const nextRoutePoint = trace.route[routePointIndex + 1];
      for (const adjacent of [previousRoutePoint, nextRoutePoint]) {
        if (
          adjacent?.route_type === "wire" &&
          distance(adjacent, routePoint) > GEOMETRY_EPSILON_MM
        ) {
          throw new Error(
            `Via ${trace.pcb_trace_id}:${routePointIndex} is adjacent to a non-colocated wire endpoint`,
          );
        }
      }
      const diameter = routePoint.via_diameter ?? defaultViaDiameter;
      primitives.push({
        kind: "via",
        center: { x: routePoint.x, y: routePoint.y },
        diameter,
        layers: getViaLayers(routePoint, boardLayers),
        bounds: expandBounds(getPointBounds(routePoint), diameter / 2),
      });
      continue;
    }

    const bridgeId = `${trace.pcb_trace_id}:${routePointIndex}:${routePoint.route_type}`;
    if (routePoint.route_type === "jumper") {
      primitives.push(
        createJumperPad(routePoint, routePoint.start, bridgeId),
        createJumperPad(routePoint, routePoint.end, bridgeId),
      );
      continue;
    }
    if (routePoint.route_type === "through_obstacle") {
      const witness = sameNetObstacles.find(
        (obstacle) =>
          obstacle.layers.includes(routePoint.from_layer) &&
          obstacle.layers.includes(routePoint.to_layer) &&
          distancePointToObstacle(routePoint.start, obstacle) <=
            GEOMETRY_EPSILON_MM &&
          distancePointToObstacle(routePoint.end, obstacle) <=
            GEOMETRY_EPSILON_MM,
      );
      if (!witness) {
        throw new Error(
          `Through-obstacle marker ${bridgeId} has no same-net multilayer obstacle witness`,
        );
      }
      primitives.push(
        createBridgeContact(
          routePoint.start,
          0,
          [routePoint.from_layer],
          bridgeId,
        ),
        createBridgeContact(routePoint.end, 0, [routePoint.to_layer], bridgeId),
      );
      continue;
    }

    const unsupportedRoutePoint: never = routePoint;
    throw new Error(
      `Unsupported route primitive: ${String((unsupportedRoutePoint as { route_type?: unknown }).route_type)}`,
    );
  }
  return primitives;
};

const getEndpointLabel = (
  connection: SimpleRouteConnection,
  connectionIndex: number,
  endpointIndex: number,
) => {
  const endpoint = connection.pointsToConnect[endpointIndex]!;
  return (
    endpoint.pointId ??
    endpoint.pcb_port_id ??
    `${connection.name}[${connectionIndex}:${endpointIndex}]`
  );
};

const createEndpointOnlySnapshot = (
  inputProblem: PowerTraceExpanderInput,
): PhysicalConnectivitySnapshot => {
  const endpointLabels: Record<string, string> = {};
  const componentByEndpointKey: Record<string, string> = {};
  const endpointComponents: string[][] = [];
  for (
    let connectionIndex = 0;
    connectionIndex < inputProblem.connections.length;
    connectionIndex++
  ) {
    const connection = inputProblem.connections[connectionIndex]!;
    for (
      let endpointIndex = 0;
      endpointIndex < connection.pointsToConnect.length;
      endpointIndex++
    ) {
      const endpointKey = `${connectionIndex}:${endpointIndex}`;
      endpointLabels[endpointKey] = getEndpointLabel(
        connection,
        connectionIndex,
        endpointIndex,
      );
      componentByEndpointKey[endpointKey] = endpointKey;
      endpointComponents.push([endpointKey]);
    }
  }
  return {
    endpointCount: Object.keys(endpointLabels).length,
    endpointLabels,
    componentByEndpointKey,
    endpointComponents,
  };
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

/**
 * Computes physical terminal components from emitted copper geometry. Wire
 * segment width follows Circuit JSON semantics: the first route point owns the
 * width of the segment that follows it.
 */
export const capturePhysicalConnectivity = (
  inputProblem: PowerTraceExpanderInput,
  routedTraces: SimplifiedPcbTrace[],
): PhysicalConnectivitySnapshot => {
  const resolver = new ConnectionNameResolver(inputProblem, routedTraces, {
    includePhysicalPositionAliases: true,
  });
  const boardLayers = getBoardLayers(inputProblem.layerCount);
  const defaultViaDiameter = getDefaultViaDiameter(inputProblem);
  const primitivesByNet = new Map<string, CopperPrimitive[]>();
  const obstaclesByNet = new Map<string, Obstacle[]>();
  const endpointLabels: Record<string, string> = {};

  const addPrimitive = (netName: string, primitive: CopperPrimitive) => {
    const primitives = primitivesByNet.get(netName) ?? [];
    primitives.push(primitive);
    primitivesByNet.set(netName, primitives);
  };

  for (
    let connectionIndex = 0;
    connectionIndex < inputProblem.connections.length;
    connectionIndex++
  ) {
    const connection = inputProblem.connections[connectionIndex]!;
    const netNames = resolver.canonicalize(getConnectionNames(connection));
    if (netNames.length !== 1) {
      throw new Error(
        `Connection ${connection.name} resolved to ${netNames.length} canonical nets`,
      );
    }
    for (
      let endpointIndex = 0;
      endpointIndex < connection.pointsToConnect.length;
      endpointIndex++
    ) {
      const endpoint = connection.pointsToConnect[endpointIndex]!;
      const endpointKey = `${connectionIndex}:${endpointIndex}`;
      const endpointLabel = getEndpointLabel(
        connection,
        connectionIndex,
        endpointIndex,
      );
      endpointLabels[endpointKey] = endpointLabel;
      const primitive: EndpointPrimitive = {
        kind: "endpoint",
        endpointKey,
        endpointLabel,
        point: { x: endpoint.x, y: endpoint.y },
        layers: endpoint.layers ?? [endpoint.layer],
        bounds: getPointBounds(endpoint),
      };
      for (const netName of netNames) addPrimitive(netName, primitive);
    }
  }

  for (const obstacle of inputProblem.obstacles) {
    const primitive: ObstaclePrimitive = {
      kind: "obstacle",
      obstacle,
      layers: obstacle.layers,
      bounds: getObstacleBounds(obstacle),
    };
    for (const netName of resolver.canonicalize(
      getObstacleConnectionNames(obstacle),
    )) {
      const obstacles = obstaclesByNet.get(netName) ?? [];
      obstacles.push(obstacle);
      obstaclesByNet.set(netName, obstacles);
      if (primitivesByNet.has(netName)) addPrimitive(netName, primitive);
    }
  }

  for (const trace of [...routedTraces, ...(inputProblem.fixedTraces ?? [])]) {
    const netNames = resolver.canonicalize(getTraceConnectionNames(trace));
    if (netNames.length !== 1) {
      throw new Error(
        `Trace ${trace.pcb_trace_id} resolved to ${netNames.length} canonical nets`,
      );
    }
    const sameNetObstacles = obstaclesByNet.get(netNames[0]!) ?? [];
    const copper = extractTraceCopper(
      trace,
      boardLayers,
      defaultViaDiameter,
      sameNetObstacles,
    );
    for (const netName of netNames) {
      if (!primitivesByNet.has(netName)) continue;
      for (const primitive of copper) addPrimitive(netName, primitive);
    }
  }

  const componentByEndpointKey: Record<string, string> = {};
  const endpointComponents: string[][] = [];
  for (const primitives of primitivesByNet.values()) {
    const connectedCopper = new DisjointSet(primitives.length);
    const firstContactByBridgeId = new Map<string, number>();
    for (let index = 0; index < primitives.length; index++) {
      const primitive = primitives[index]!;
      if (
        primitive.kind !== "bridge-contact" &&
        primitive.kind !== "bridge-pad"
      ) {
        continue;
      }
      const firstIndex = firstContactByBridgeId.get(primitive.bridgeId);
      if (firstIndex === undefined) {
        firstContactByBridgeId.set(primitive.bridgeId, index);
      } else {
        connectedCopper.union(firstIndex, index);
      }
    }

    const spatialIndex =
      primitives.length > 0 ? new Flatbush(primitives.length) : null;
    if (spatialIndex) {
      for (const primitive of primitives) {
        spatialIndex.add(
          primitive.bounds.minX,
          primitive.bounds.minY,
          primitive.bounds.maxX,
          primitive.bounds.maxY,
        );
      }
      spatialIndex.finish();
    }
    for (let firstIndex = 0; firstIndex < primitives.length; firstIndex++) {
      const first = primitives[firstIndex]!;
      const candidates =
        spatialIndex?.search(
          first.bounds.minX - GEOMETRY_EPSILON_MM,
          first.bounds.minY - GEOMETRY_EPSILON_MM,
          first.bounds.maxX + GEOMETRY_EPSILON_MM,
          first.bounds.maxY + GEOMETRY_EPSILON_MM,
        ) ?? [];
      for (const secondIndex of candidates) {
        if (secondIndex <= firstIndex) continue;
        if (primitivesTouch(first, primitives[secondIndex]!)) {
          connectedCopper.union(firstIndex, secondIndex);
        }
      }
    }

    const endpointsByRoot = new Map<number, string[]>();
    for (let index = 0; index < primitives.length; index++) {
      const primitive = primitives[index]!;
      if (primitive.kind !== "endpoint") continue;
      const root = connectedCopper.find(index);
      const endpointKeys = endpointsByRoot.get(root) ?? [];
      endpointKeys.push(primitive.endpointKey);
      endpointsByRoot.set(root, endpointKeys);
    }
    for (const endpointKeys of endpointsByRoot.values()) {
      endpointKeys.sort();
      const componentId = endpointKeys[0]!;
      endpointComponents.push(endpointKeys);
      for (const endpointKey of endpointKeys) {
        if (componentByEndpointKey[endpointKey] !== undefined) {
          throw new Error(
            `Endpoint ${endpointKey} was assigned to multiple canonical nets`,
          );
        }
        componentByEndpointKey[endpointKey] = componentId;
      }
    }
  }

  endpointComponents.sort(([first = ""], [second = ""]) =>
    first.localeCompare(second),
  );
  return {
    endpointCount: Object.keys(endpointLabels).length,
    endpointLabels,
    componentByEndpointKey,
    endpointComponents,
  };
};

/**
 * A safe output may merge input terminal components, but it may never split a
 * component that was physically connected in the input.
 */
export class PhysicalConnectivityInvariant {
  readonly baseline: PhysicalConnectivitySnapshot;
  private readonly inputProblem: PowerTraceExpanderInput;
  private readonly baselineCaptureError: string | null;
  private readonly baselineTraceSignature: string;

  constructor(
    inputProblem: PowerTraceExpanderInput,
    baselineTraces: SimplifiedPcbTrace[],
  ) {
    this.inputProblem = inputProblem;
    this.baselineTraceSignature = stableSerialize(baselineTraces);
    try {
      this.baseline = capturePhysicalConnectivity(inputProblem, baselineTraces);
      this.baselineCaptureError = null;
    } catch (error) {
      this.baseline = createEndpointOnlySnapshot(inputProblem);
      this.baselineCaptureError =
        error instanceof Error ? error.message : String(error);
    }
  }

  validate(
    candidateTraces: SimplifiedPcbTrace[],
  ): PhysicalConnectivityValidation {
    if (this.baselineCaptureError) {
      const unchanged =
        stableSerialize(candidateTraces) === this.baselineTraceSignature;
      return {
        safe: unchanged,
        candidate: this.baseline,
        regressions: [],
        validationError: unchanged
          ? `Connectivity validation is limited to exact trace preservation: ${this.baselineCaptureError}`
          : `Connectivity validation failed closed: ${this.baselineCaptureError}`,
      };
    }

    let candidate: PhysicalConnectivitySnapshot;
    try {
      candidate = capturePhysicalConnectivity(
        this.inputProblem,
        candidateTraces,
      );
    } catch (error) {
      return {
        safe: false,
        candidate: createEndpointOnlySnapshot(this.inputProblem),
        regressions: [],
        validationError: `Connectivity validation failed closed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    const regressions: PhysicalConnectivityRegression[] = [];

    for (const baselineEndpointKeys of this.baseline.endpointComponents) {
      if (baselineEndpointKeys.length < 2) continue;
      const candidateComponentsById = new Map<string, string[]>();
      for (const endpointKey of baselineEndpointKeys) {
        const candidateComponentId =
          candidate.componentByEndpointKey[endpointKey] ??
          `missing:${endpointKey}`;
        const endpointKeys =
          candidateComponentsById.get(candidateComponentId) ?? [];
        endpointKeys.push(endpointKey);
        candidateComponentsById.set(candidateComponentId, endpointKeys);
      }
      if (candidateComponentsById.size <= 1) continue;
      regressions.push({
        baselineEndpointKeys: [...baselineEndpointKeys],
        baselineEndpointLabels: baselineEndpointKeys.map(
          (endpointKey) => this.baseline.endpointLabels[endpointKey]!,
        ),
        candidateComponents: [...candidateComponentsById.values()],
      });
    }

    return {
      safe: regressions.length === 0,
      candidate,
      regressions,
    };
  }
}
