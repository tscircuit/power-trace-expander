import { distancePointToSegment } from "./geometry";
import { SpatialObstacleIndex } from "./SpatialObstacleIndex";
import type {
  PowerTraceExpanderInput,
  SimplifiedPcbTrace,
  ViaRoutePoint,
  WireRoutePoint,
} from "./types";

type Point = { x: number; y: number };
type Vector = Point;

type AdjacentSegment = {
  start: Point;
  end: Point;
  width: number;
};

type ViaArrayContext = {
  incomingSegment: AdjacentSegment;
  outgoingSegment: AdjacentSegment;
  perpendicularDirection: Vector;
  traceWidth: number;
};

export type AddViaArraysToWideTracesOptions = {
  simpleRouteJson: PowerTraceExpanderInput;
  traces: SimplifiedPcbTrace[];
  traceIndices?: readonly number[];
};

export type AddViaArraysToWideTracesResult = {
  traces: SimplifiedPcbTrace[];
  addedViaArrayCount: number;
  addedViaCount: number;
  skippedViaArrayCount: number;
};

const SAME_POINT_TOLERANCE = 1e-9;
const VIA_ARRAY_ROTATION_OFFSETS = [0, 15, -15, 30, -30, 45, -45].map(
  (degrees) => (degrees * Math.PI) / 180,
);

const getTraceConnectionNames = (trace: SimplifiedPcbTrace): string[] =>
  [
    trace.connection_name,
    trace.source_trace_id,
    trace.rootConnectionName,
    ...(trace.mergedConnectionNames ?? []),
    ...(trace.connectsTo ?? []),
  ].filter((name): name is string => Boolean(name));

const getViaArrayContext = (
  route: SimplifiedPcbTrace["route"],
  viaIndex: number,
  via: ViaRoutePoint,
): ViaArrayContext | null => {
  let previousWire: WireRoutePoint | undefined;
  let previousAnchor: WireRoutePoint | undefined;
  for (let index = viaIndex - 1; index >= 0; index--) {
    const point = route[index];
    if (point?.route_type !== "wire") continue;
    previousWire ??= point;
    if (Math.hypot(point.x - via.x, point.y - via.y) > SAME_POINT_TOLERANCE) {
      previousAnchor = point;
      break;
    }
  }

  let nextWire: WireRoutePoint | undefined;
  let nextAnchor: WireRoutePoint | undefined;
  for (let index = viaIndex + 1; index < route.length; index++) {
    const point = route[index];
    if (point?.route_type !== "wire") continue;
    nextWire ??= point;
    if (Math.hypot(point.x - via.x, point.y - via.y) > SAME_POINT_TOLERANCE) {
      nextAnchor = point;
      break;
    }
  }

  if (!previousWire || !previousAnchor || !nextWire || !nextAnchor) {
    return null;
  }

  const incomingLength = Math.hypot(
    via.x - previousAnchor.x,
    via.y - previousAnchor.y,
  );
  const outgoingLength = Math.hypot(nextAnchor.x - via.x, nextAnchor.y - via.y);
  if (
    incomingLength <= SAME_POINT_TOLERANCE ||
    outgoingLength <= SAME_POINT_TOLERANCE
  ) {
    return null;
  }

  const incomingDirection = {
    x: (via.x - previousAnchor.x) / incomingLength,
    y: (via.y - previousAnchor.y) / incomingLength,
  };
  const outgoingDirection = {
    x: (nextAnchor.x - via.x) / outgoingLength,
    y: (nextAnchor.y - via.y) / outgoingLength,
  };
  const traceDirection = {
    x: incomingDirection.x + outgoingDirection.x,
    y: incomingDirection.y + outgoingDirection.y,
  };
  let traceDirectionLength = Math.hypot(traceDirection.x, traceDirection.y);

  if (traceDirectionLength <= SAME_POINT_TOLERANCE) {
    traceDirection.x = incomingDirection.x;
    traceDirection.y = incomingDirection.y;
    traceDirectionLength = 1;
  }

  const incomingWidth = previousAnchor.width;
  const outgoingWidth = nextWire.width;
  return {
    incomingSegment: {
      start: previousAnchor,
      end: via,
      width: incomingWidth,
    },
    outgoingSegment: {
      start: via,
      end: nextAnchor,
      width: outgoingWidth,
    },
    perpendicularDirection: {
      x: -traceDirection.y / traceDirectionLength,
      y: traceDirection.x / traceDirectionLength,
    },
    traceWidth: Math.min(incomingWidth, outgoingWidth),
  };
};

const viaFitsInsideSegment = (
  point: Point,
  viaDiameter: number,
  segment: AdjacentSegment,
): boolean =>
  distancePointToSegment(point, segment.start, segment.end) + viaDiameter / 2 <=
  segment.width / 2 + SAME_POINT_TOLERANCE;

const createViaArray = ({
  via,
  context,
  direction,
  viaDiameter,
  minimumViaClearance,
}: {
  via: ViaRoutePoint;
  context: ViaArrayContext;
  direction: Vector;
  viaDiameter: number;
  minimumViaClearance: number;
}): ViaRoutePoint[] | null => {
  if (context.traceWidth <= viaDiameter + SAME_POINT_TOLERANCE) return null;

  const viaCount = Math.floor(
    (context.traceWidth + minimumViaClearance) /
      (viaDiameter + minimumViaClearance),
  );
  if (viaCount < 2) return null;

  const centerIndex = (viaCount - 1) / 2;
  const viaPitch = (context.traceWidth - viaDiameter) / (viaCount - 1);
  const viaArray = Array.from(
    { length: viaCount },
    (_, viaIndex): ViaRoutePoint => {
      const offset = (viaIndex - centerIndex) * viaPitch;
      return {
        ...via,
        x: via.x + direction.x * offset,
        y: via.y + direction.y * offset,
      };
    },
  );

  if (
    viaArray.some(
      (candidate) =>
        !viaFitsInsideSegment(
          candidate,
          viaDiameter,
          context.incomingSegment,
        ) ||
        !viaFitsInsideSegment(candidate, viaDiameter, context.outgoingSegment),
    )
  ) {
    return null;
  }

  return viaArray;
};

const createViaArrayCandidates = ({
  via,
  context,
  viaDiameter,
  minimumViaClearance,
}: {
  via: ViaRoutePoint;
  context: ViaArrayContext;
  viaDiameter: number;
  minimumViaClearance: number;
}): ViaRoutePoint[][] =>
  VIA_ARRAY_ROTATION_OFFSETS.flatMap((rotation) => {
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const direction = {
      x:
        context.perpendicularDirection.x * cos -
        context.perpendicularDirection.y * sin,
      y:
        context.perpendicularDirection.x * sin +
        context.perpendicularDirection.y * cos,
    };
    const viaArray = createViaArray({
      via,
      context,
      direction,
      viaDiameter,
      minimumViaClearance,
    });
    return viaArray ? [viaArray] : [];
  });

const getViaDiameter = (
  via: ViaRoutePoint,
  simpleRouteJson: PowerTraceExpanderInput,
): number =>
  via.via_diameter ??
  simpleRouteJson.min_via_pad_diameter ??
  simpleRouteJson.minViaPadDiameter ??
  simpleRouteJson.minViaDiameter ??
  0.6;

const violatesViaPadClearance = ({
  candidate,
  viaDiameter,
  currentTraceIndex,
  currentRouteIndex,
  minimumViaClearance,
  simpleRouteJson,
  traces,
}: {
  candidate: Point;
  viaDiameter: number;
  currentTraceIndex: number;
  currentRouteIndex: number;
  minimumViaClearance: number;
  simpleRouteJson: PowerTraceExpanderInput;
  traces: SimplifiedPcbTrace[];
}): boolean =>
  traces.some((trace, traceIndex) =>
    trace.route.some((point, routeIndex) => {
      if (point.route_type !== "via") return false;
      if (
        traceIndex === currentTraceIndex &&
        routeIndex === currentRouteIndex
      ) {
        return false;
      }
      const minimumCenterDistance =
        viaDiameter / 2 +
        getViaDiameter(point, simpleRouteJson) / 2 +
        minimumViaClearance;
      return (
        Math.hypot(point.x - candidate.x, point.y - candidate.y) <
        minimumCenterDistance - SAME_POINT_TOLERANCE
      );
    }),
  );

export const addViaArraysToWideTraces = ({
  simpleRouteJson,
  traces,
  traceIndices,
}: AddViaArraysToWideTracesOptions): AddViaArraysToWideTracesResult => {
  const outputTraces = structuredClone(traces);
  const selectedTraceIndices = traceIndices
    ? new Set(traceIndices)
    : new Set(outputTraces.map((_, traceIndex) => traceIndex));
  let addedViaArrayCount = 0;
  let addedViaCount = 0;
  let skippedViaArrayCount = 0;

  for (let traceIndex = 0; traceIndex < outputTraces.length; traceIndex++) {
    if (!selectedTraceIndices.has(traceIndex)) continue;
    const trace = outputTraces[traceIndex]!;

    for (let routeIndex = 0; routeIndex < trace.route.length; routeIndex++) {
      const point = trace.route[routeIndex];
      if (point?.route_type !== "via") continue;

      const obstacleIndex = new SpatialObstacleIndex(
        simpleRouteJson,
        outputTraces,
      );
      const viaDiameter = getViaDiameter(point, simpleRouteJson);
      const viaHoleDiameter =
        point.via_hole_diameter ?? obstacleIndex.defaultViaHoleDiameter;
      const context = getViaArrayContext(trace.route, routeIndex, point);
      if (
        !context ||
        context.traceWidth <= viaDiameter + SAME_POINT_TOLERANCE
      ) {
        continue;
      }

      const viaArrayCandidates = createViaArrayCandidates({
        via: point,
        context,
        viaDiameter,
        minimumViaClearance: obstacleIndex.clearance,
      });
      if (viaArrayCandidates.length === 0) {
        skippedViaArrayCount++;
        continue;
      }

      const connectionNames = getTraceConnectionNames(trace);
      const viaArray = viaArrayCandidates.find(
        (candidateArray) =>
          !candidateArray.some(
            (candidate, candidateIndex) =>
              violatesViaPadClearance({
                candidate,
                viaDiameter,
                currentTraceIndex: traceIndex,
                currentRouteIndex: routeIndex,
                minimumViaClearance: obstacleIndex.clearance,
                simpleRouteJson,
                traces: outputTraces,
              }) ||
              obstacleIndex.collidesVia({
                point: candidate,
                layers: obstacleIndex.boardLayers,
                padDiameter: viaDiameter,
                holeDiameter: viaHoleDiameter,
                connectionNames,
                ignoreTraceIndex: traceIndex,
                ignoreRouteRange: { start: routeIndex, end: routeIndex },
                obstacleClearance: obstacleIndex.clearance,
                blockSameNetObstacles: true,
                sameNetObstacleClearance: 0,
                otherNewViaPoints: candidateArray.slice(0, candidateIndex),
              }),
          ),
      );
      if (!viaArray) {
        skippedViaArrayCount++;
        continue;
      }

      trace.route.splice(routeIndex, 1, ...viaArray);
      routeIndex += viaArray.length - 1;
      addedViaArrayCount++;
      addedViaCount += viaArray.length - 1;
    }
  }

  return {
    traces: outputTraces,
    addedViaArrayCount,
    addedViaCount,
    skippedViaArrayCount,
  };
};
