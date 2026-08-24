import type {
  Obstacle,
  Point,
  PowerTraceExpanderInput,
  SimpleRouteConnection,
  SimplifiedPcbTrace,
} from "../../src/types";

const GEOMETRY_EPSILON_MM = 1e-6;

type ConnectionPoint = SimpleRouteConnection["pointsToConnect"][number];
type WireRoutePoint = Extract<
  SimplifiedPcbTrace["route"][number],
  { route_type: "wire" }
>;

type RoutedSegment = {
  start: Point;
  end: Point;
  width: number;
  layer: string;
};

type EndpointCopper = {
  type: "endpoint";
  point: ConnectionPoint;
};

type ObstacleCopper = {
  type: "obstacle";
  obstacle: Obstacle;
};

type SegmentCopper = {
  type: "segment";
  segment: RoutedSegment;
};

type ViaCopper = {
  type: "via";
  center: Point;
  diameter: number;
  layers: string[];
};

type CopperPrimitive =
  | EndpointCopper
  | ObstacleCopper
  | SegmentCopper
  | ViaCopper;

export type ConnectionEndpointConnectivity = {
  connectionName: string;
  checkedEndpointCount: number;
  connectedEndpointCount: number;
  disconnectedEndpointIndices: number[];
};

export type PhysicalEndpointConnectivityReport = {
  checkedConnectionCount: number;
  connectedConnectionCount: number;
  checkedEndpointCount: number;
  connectedEndpointCount: number;
  connections: ConnectionEndpointConnectivity[];
};

const distance = (first: Point, second: Point) =>
  Math.hypot(first.x - second.x, first.y - second.y);

const distancePointToSegment = ({
  point,
  start,
  end,
}: {
  point: Point;
  start: Point;
  end: Point;
}) => {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  const rawPosition =
    lengthSquared < GEOMETRY_EPSILON_MM
      ? 0
      : ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared;
  const position = Math.max(0, Math.min(1, rawPosition));
  return Math.hypot(
    point.x - (start.x + position * dx),
    point.y - (start.y + position * dy),
  );
};

const crossProduct = ({
  origin,
  first,
  second,
}: {
  origin: Point;
  first: Point;
  second: Point;
}) =>
  (first.x - origin.x) * (second.y - origin.y) -
  (first.y - origin.y) * (second.x - origin.x);

const segmentsProperlyCross = ({
  firstStart,
  firstEnd,
  secondStart,
  secondEnd,
}: {
  firstStart: Point;
  firstEnd: Point;
  secondStart: Point;
  secondEnd: Point;
}) => {
  const firstDirection = crossProduct({
    origin: secondStart,
    first: secondEnd,
    second: firstStart,
  });
  const secondDirection = crossProduct({
    origin: secondStart,
    first: secondEnd,
    second: firstEnd,
  });
  const thirdDirection = crossProduct({
    origin: firstStart,
    first: firstEnd,
    second: secondStart,
  });
  const fourthDirection = crossProduct({
    origin: firstStart,
    first: firstEnd,
    second: secondEnd,
  });
  return (
    ((firstDirection > 0 && secondDirection < 0) ||
      (firstDirection < 0 && secondDirection > 0)) &&
    ((thirdDirection > 0 && fourthDirection < 0) ||
      (thirdDirection < 0 && fourthDirection > 0))
  );
};

const distanceSegmentToSegment = ({
  firstStart,
  firstEnd,
  secondStart,
  secondEnd,
}: {
  firstStart: Point;
  firstEnd: Point;
  secondStart: Point;
  secondEnd: Point;
}) => {
  if (
    segmentsProperlyCross({
      firstStart,
      firstEnd,
      secondStart,
      secondEnd,
    })
  ) {
    return 0;
  }
  return Math.min(
    distancePointToSegment({
      point: firstStart,
      start: secondStart,
      end: secondEnd,
    }),
    distancePointToSegment({
      point: firstEnd,
      start: secondStart,
      end: secondEnd,
    }),
    distancePointToSegment({
      point: secondStart,
      start: firstStart,
      end: firstEnd,
    }),
    distancePointToSegment({
      point: secondEnd,
      start: firstStart,
      end: firstEnd,
    }),
  );
};

const obstacleIsCircular = (obstacle: Obstacle) =>
  "shape" in obstacle && obstacle.shape === "circle";

const toObstacleLocalPoint = (point: Point, obstacle: Obstacle): Point => {
  const rotationRadians = -((obstacle.ccwRotationDegrees ?? 0) * Math.PI) / 180;
  const dx = point.x - obstacle.center.x;
  const dy = point.y - obstacle.center.y;
  return {
    x: dx * Math.cos(rotationRadians) - dy * Math.sin(rotationRadians),
    y: dx * Math.sin(rotationRadians) + dy * Math.cos(rotationRadians),
  };
};

const pointIsInsideObstacle = ({
  point,
  obstacle,
}: {
  point: Point;
  obstacle: Obstacle;
}) => {
  if (obstacleIsCircular(obstacle)) {
    return (
      distance(point, obstacle.center) <=
      obstacle.width / 2 + GEOMETRY_EPSILON_MM
    );
  }
  const localPoint = toObstacleLocalPoint(point, obstacle);
  return (
    Math.abs(localPoint.x) <= obstacle.width / 2 + GEOMETRY_EPSILON_MM &&
    Math.abs(localPoint.y) <= obstacle.height / 2 + GEOMETRY_EPSILON_MM
  );
};

const distancePointToObstacle = ({
  point,
  obstacle,
}: {
  point: Point;
  obstacle: Obstacle;
}) => {
  if (obstacleIsCircular(obstacle)) {
    return Math.max(0, distance(point, obstacle.center) - obstacle.width / 2);
  }
  const localPoint = toObstacleLocalPoint(point, obstacle);
  const dx = Math.max(Math.abs(localPoint.x) - obstacle.width / 2, 0);
  const dy = Math.max(Math.abs(localPoint.y) - obstacle.height / 2, 0);
  return Math.hypot(dx, dy);
};

const distanceSegmentToObstacle = ({
  segment,
  obstacle,
}: {
  segment: RoutedSegment;
  obstacle: Obstacle;
}) => {
  if (obstacleIsCircular(obstacle)) {
    return Math.max(
      0,
      distancePointToSegment({
        point: obstacle.center,
        start: segment.start,
        end: segment.end,
      }) -
        obstacle.width / 2,
    );
  }
  const localStart = toObstacleLocalPoint(segment.start, obstacle);
  const localEnd = toObstacleLocalPoint(segment.end, obstacle);
  const minX = -obstacle.width / 2;
  const maxX = obstacle.width / 2;
  const minY = -obstacle.height / 2;
  const maxY = obstacle.height / 2;
  if (
    (localStart.x >= minX &&
      localStart.x <= maxX &&
      localStart.y >= minY &&
      localStart.y <= maxY) ||
    (localEnd.x >= minX &&
      localEnd.x <= maxX &&
      localEnd.y >= minY &&
      localEnd.y <= maxY)
  ) {
    return 0;
  }
  const corners = [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
  ];
  let minimumDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < corners.length; index++) {
    minimumDistance = Math.min(
      minimumDistance,
      distanceSegmentToSegment({
        firstStart: localStart,
        firstEnd: localEnd,
        secondStart: corners[index]!,
        secondEnd: corners[(index + 1) % corners.length]!,
      }),
    );
  }
  return minimumDistance;
};

const getCopperLayerNames = (layerCount: number) => {
  if (layerCount === 1) return ["top"];
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

const getLayerSpan = ({
  fromLayer,
  toLayer,
  layerNames,
}: {
  fromLayer: string;
  toLayer: string;
  layerNames: string[];
}) => {
  const fromIndex = layerNames.indexOf(fromLayer);
  const toIndex = layerNames.indexOf(toLayer);
  if (fromIndex < 0 || toIndex < 0) {
    throw new Error(`Cannot build via span from ${fromLayer} to ${toLayer}`);
  }
  return layerNames.slice(
    Math.min(fromIndex, toIndex),
    Math.max(fromIndex, toIndex) + 1,
  );
};

const extractTraceCopper = (
  trace: SimplifiedPcbTrace,
  layerNames: string[],
): Array<SegmentCopper | ViaCopper> => {
  const copper: Array<SegmentCopper | ViaCopper> = [];
  let previousWire: WireRoutePoint | undefined;
  for (const routePoint of trace.route) {
    if (routePoint.route_type === "via") {
      copper.push({
        type: "via",
        center: { x: routePoint.x, y: routePoint.y },
        diameter: routePoint.via_diameter ?? 0,
        layers: getLayerSpan({
          fromLayer: routePoint.from_layer,
          toLayer: routePoint.to_layer,
          layerNames,
        }),
      });
      previousWire = undefined;
      continue;
    }
    if (routePoint.route_type !== "wire") continue;
    if (
      previousWire &&
      previousWire.layer === routePoint.layer &&
      distance(previousWire, routePoint) > GEOMETRY_EPSILON_MM
    ) {
      copper.push({
        type: "segment",
        segment: {
          start: { x: previousWire.x, y: previousWire.y },
          end: { x: routePoint.x, y: routePoint.y },
          width: routePoint.width,
          layer: routePoint.layer,
        },
      });
    }
    previousWire = routePoint;
  }
  return copper;
};

const primitivesTouch = (first: CopperPrimitive, second: CopperPrimitive) => {
  if (first.type === "endpoint" && second.type === "endpoint") {
    return (
      first.point.layer === second.point.layer &&
      distance(first.point, second.point) <= GEOMETRY_EPSILON_MM
    );
  }
  if (first.type === "endpoint" && second.type === "obstacle") {
    return (
      second.obstacle.layers.includes(first.point.layer) &&
      pointIsInsideObstacle({
        point: first.point,
        obstacle: second.obstacle,
      })
    );
  }
  if (first.type === "obstacle" && second.type === "endpoint") {
    return primitivesTouch(second, first);
  }
  if (first.type === "endpoint" && second.type === "segment") {
    return (
      first.point.layer === second.segment.layer &&
      distancePointToSegment({
        point: first.point,
        start: second.segment.start,
        end: second.segment.end,
      }) <=
        second.segment.width / 2 + GEOMETRY_EPSILON_MM
    );
  }
  if (first.type === "segment" && second.type === "endpoint") {
    return primitivesTouch(second, first);
  }
  if (first.type === "endpoint" && second.type === "via") {
    return (
      second.layers.includes(first.point.layer) &&
      distance(first.point, second.center) <=
        second.diameter / 2 + GEOMETRY_EPSILON_MM
    );
  }
  if (first.type === "via" && second.type === "endpoint") {
    return primitivesTouch(second, first);
  }
  if (first.type === "obstacle" && second.type === "segment") {
    return (
      first.obstacle.layers.includes(second.segment.layer) &&
      distanceSegmentToObstacle({
        segment: second.segment,
        obstacle: first.obstacle,
      }) <=
        second.segment.width / 2 + GEOMETRY_EPSILON_MM
    );
  }
  if (first.type === "segment" && second.type === "obstacle") {
    return primitivesTouch(second, first);
  }
  if (first.type === "obstacle" && second.type === "via") {
    return (
      first.obstacle.layers.some((layer) => second.layers.includes(layer)) &&
      distancePointToObstacle({
        point: second.center,
        obstacle: first.obstacle,
      }) <=
        second.diameter / 2 + GEOMETRY_EPSILON_MM
    );
  }
  if (first.type === "via" && second.type === "obstacle") {
    return primitivesTouch(second, first);
  }
  if (first.type === "segment" && second.type === "segment") {
    return (
      first.segment.layer === second.segment.layer &&
      distanceSegmentToSegment({
        firstStart: first.segment.start,
        firstEnd: first.segment.end,
        secondStart: second.segment.start,
        secondEnd: second.segment.end,
      }) <=
        (first.segment.width + second.segment.width) / 2 + GEOMETRY_EPSILON_MM
    );
  }
  if (first.type === "segment" && second.type === "via") {
    return (
      second.layers.includes(first.segment.layer) &&
      distancePointToSegment({
        point: second.center,
        start: first.segment.start,
        end: first.segment.end,
      }) <=
        second.diameter / 2 + first.segment.width / 2 + GEOMETRY_EPSILON_MM
    );
  }
  if (first.type === "via" && second.type === "segment") {
    return primitivesTouch(second, first);
  }
  if (first.type === "via" && second.type === "via") {
    return (
      first.layers.some((layer) => second.layers.includes(layer)) &&
      distance(first.center, second.center) <=
        (first.diameter + second.diameter) / 2 + GEOMETRY_EPSILON_MM
    );
  }
  return false;
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

  union(first: number, second: number): void {
    const firstRoot = this.find(first);
    const secondRoot = this.find(second);
    if (firstRoot !== secondRoot) this.parent[secondRoot] = firstRoot;
  }
}

const getConnectionObstacles = (
  inputProblem: PowerTraceExpanderInput,
  connection: SimpleRouteConnection,
) => {
  const connectionTokens = new Set(
    connection.pointsToConnect.flatMap((point) => [
      point.pointId,
      point.pcb_port_id,
    ]),
  );
  connectionTokens.add(connection.name);

  let tokenAdded = true;
  while (tokenAdded) {
    tokenAdded = false;
    for (const obstacle of inputProblem.obstacles) {
      if (!obstacle.connectedTo.some((token) => connectionTokens.has(token))) {
        continue;
      }
      for (const token of obstacle.connectedTo) {
        if (connectionTokens.has(token)) continue;
        connectionTokens.add(token);
        tokenAdded = true;
      }
    }
  }

  return inputProblem.obstacles.filter((obstacle) =>
    obstacle.connectedTo.some((token) => connectionTokens.has(token)),
  );
};

/**
 * Proves endpoint connectivity from emitted wire, via, and connected-pad
 * geometry. Connection-name presence alone does not count as connectivity.
 */
export const getPhysicalEndpointConnectivity = ({
  inputProblem,
  routedTraces,
}: {
  inputProblem: PowerTraceExpanderInput;
  routedTraces: SimplifiedPcbTrace[];
}): PhysicalEndpointConnectivityReport => {
  const layerNames = getCopperLayerNames(inputProblem.layerCount);
  const connections = inputProblem.connections.map((connection) => {
    const endpointCopper: EndpointCopper[] = connection.pointsToConnect.map(
      (point) => ({ type: "endpoint", point }),
    );
    const obstacleCopper: ObstacleCopper[] = getConnectionObstacles(
      inputProblem,
      connection,
    ).map((obstacle) => ({ type: "obstacle", obstacle }));
    const routeCopper = routedTraces
      .filter((trace) => trace.connection_name === connection.name)
      .flatMap((trace) => extractTraceCopper(trace, layerNames));
    const copper: CopperPrimitive[] = [
      ...endpointCopper,
      ...obstacleCopper,
      ...routeCopper,
    ];
    const connectedCopper = new DisjointSet(copper.length);
    for (let firstIndex = 0; firstIndex < copper.length; firstIndex++) {
      for (
        let secondIndex = firstIndex + 1;
        secondIndex < copper.length;
        secondIndex++
      ) {
        if (primitivesTouch(copper[firstIndex]!, copper[secondIndex]!)) {
          connectedCopper.union(firstIndex, secondIndex);
        }
      }
    }

    const firstEndpointRoot = connectedCopper.find(0);
    const disconnectedEndpointIndices = endpointCopper.flatMap(
      (_, endpointIndex) =>
        connectedCopper.find(endpointIndex) === firstEndpointRoot
          ? []
          : [endpointIndex],
    );
    return {
      connectionName: connection.name,
      checkedEndpointCount: endpointCopper.length,
      connectedEndpointCount:
        endpointCopper.length - disconnectedEndpointIndices.length,
      disconnectedEndpointIndices,
    };
  });
  return {
    checkedConnectionCount: connections.length,
    connectedConnectionCount: connections.filter(
      (connection) => connection.disconnectedEndpointIndices.length === 0,
    ).length,
    checkedEndpointCount: connections.reduce(
      (count, connection) => count + connection.checkedEndpointCount,
      0,
    ),
    connectedEndpointCount: connections.reduce(
      (count, connection) => count + connection.connectedEndpointCount,
      0,
    ),
    connections,
  };
};
