import type { Obstacle } from "@tscircuit/core";
import type { IndexedObstacle, Point, WireRoutePoint } from "./types";

export const WIDTH_EPSILON = 1e-6;

export const distance = (a: Point, b: Point) =>
  Math.hypot(b.x - a.x, b.y - a.y);

export const distancePointToSegment = (
  point: Point,
  start: Point,
  end: Point,
) => {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const lengthSquared = deltaX * deltaX + deltaY * deltaY;
  if (lengthSquared <= 1e-12) return distance(point, start);
  const t = clamp(
    ((point.x - start.x) * deltaX + (point.y - start.y) * deltaY) /
      lengthSquared,
    0,
    1,
  );
  return Math.hypot(
    point.x - (start.x + deltaX * t),
    point.y - (start.y + deltaY * t),
  );
};

export const pointsEqual = (a: Point, b: Point, epsilon = 1e-6) =>
  Math.abs(a.x - b.x) <= epsilon && Math.abs(a.y - b.y) <= epsilon;

export const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

export const getApproximationChunkLength = (width: number) =>
  clamp(width * 1.25, 0.25, 0.75);

export function segmentIntersectsRect(
  start: Point,
  end: Point,
  rect: { minX: number; minY: number; maxX: number; maxY: number },
) {
  let entry = 0;
  let exit = 1;
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const constraints: Array<[number, number]> = [
    [-deltaX, start.x - rect.minX],
    [deltaX, rect.maxX - start.x],
    [-deltaY, start.y - rect.minY],
    [deltaY, rect.maxY - start.y],
  ];

  for (const [direction, distanceToEdge] of constraints) {
    if (Math.abs(direction) < 1e-12) {
      if (distanceToEdge < 0) return false;
      continue;
    }
    const ratio = distanceToEdge / direction;
    if (direction < 0) entry = Math.max(entry, ratio);
    else exit = Math.min(exit, ratio);
    if (entry > exit) return false;
  }
  return true;
}

export function approximateSegmentWithRects({
  start,
  end,
  width,
  base,
}: {
  start: Point;
  end: Point;
  width: number;
  base: Omit<IndexedObstacle, "minX" | "minY" | "maxX" | "maxY">;
}): IndexedObstacle[] {
  const length = distance(start, end);
  const chunkLength = getApproximationChunkLength(width);
  const chunkCount = Math.max(1, Math.ceil(length / chunkLength));
  const radius = width / 2;
  const rects: IndexedObstacle[] = [];

  for (let index = 0; index < chunkCount; index++) {
    const t0 = index / chunkCount;
    const t1 = (index + 1) / chunkCount;
    const x0 = start.x + (end.x - start.x) * t0;
    const y0 = start.y + (end.y - start.y) * t0;
    const x1 = start.x + (end.x - start.x) * t1;
    const y1 = start.y + (end.y - start.y) * t1;
    rects.push({
      ...base,
      minX: Math.min(x0, x1) - radius,
      minY: Math.min(y0, y1) - radius,
      maxX: Math.max(x0, x1) + radius,
      maxY: Math.max(y0, y1) + radius,
    });
  }

  return rects;
}

const rotatePoint = (point: Point, center: Point, radians: number): Point => {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  return {
    x: center.x + dx * cos - dy * sin,
    y: center.y + dx * sin + dy * cos,
  };
};

export function approximateObstacleWithRects(
  obstacle: Obstacle,
  maxCellSize = 0.6,
): IndexedObstacle[] {
  const rotation = ((obstacle.ccwRotationDegrees ?? 0) * Math.PI) / 180;
  const columns = Math.max(1, Math.ceil(obstacle.width / maxCellSize));
  const rows = Math.max(1, Math.ceil(obstacle.height / maxCellSize));
  const cellWidth = obstacle.width / columns;
  const cellHeight = obstacle.height / rows;
  const rects: IndexedObstacle[] = [];

  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const localCenter = {
        x: obstacle.center.x - obstacle.width / 2 + (column + 0.5) * cellWidth,
        y: obstacle.center.y - obstacle.height / 2 + (row + 0.5) * cellHeight,
      };
      const halfWidth = cellWidth / 2;
      const halfHeight = cellHeight / 2;
      const corners = [
        { x: localCenter.x - halfWidth, y: localCenter.y - halfHeight },
        { x: localCenter.x + halfWidth, y: localCenter.y - halfHeight },
        { x: localCenter.x + halfWidth, y: localCenter.y + halfHeight },
        { x: localCenter.x - halfWidth, y: localCenter.y + halfHeight },
      ].map((point) => rotatePoint(point, obstacle.center, rotation));

      rects.push({
        minX: Math.min(...corners.map((point) => point.x)),
        minY: Math.min(...corners.map((point) => point.y)),
        maxX: Math.max(...corners.map((point) => point.x)),
        maxY: Math.max(...corners.map((point) => point.y)),
        layers: obstacle.layers,
        kind: "obstacle",
        connectionNames: obstacle.connectedTo,
      });
    }
  }

  return rects;
}

export function splitUnderWidthWireSegments(
  route: Array<WireRoutePoint | Record<string, unknown>>,
  nominalWidth: number,
): Array<WireRoutePoint | Record<string, unknown>> {
  if (route.length < 2) return route.map((point) => ({ ...point }));

  const output: Array<WireRoutePoint | Record<string, unknown>> = [];
  for (let index = 0; index < route.length - 1; index++) {
    const current = route[index] as SimplifiedRoutePoint;
    const next = route[index + 1] as SimplifiedRoutePoint;
    output.push({ ...current });

    if (
      current.route_type !== "wire" ||
      next.route_type !== "wire" ||
      current.layer !== next.layer ||
      (current.width >= nominalWidth - WIDTH_EPSILON &&
        next.width >= nominalWidth - WIDTH_EPSILON)
    ) {
      continue;
    }

    const segmentLength = distance(current, next);
    const splitCount = Math.max(1, Math.ceil(segmentLength / nominalWidth));
    for (let splitIndex = 1; splitIndex < splitCount; splitIndex++) {
      const t = splitIndex / splitCount;
      output.push({
        route_type: "wire",
        x: current.x + (next.x - current.x) * t,
        y: current.y + (next.y - current.y) * t,
        width: current.width + (next.width - current.width) * t,
        layer: current.layer,
      });
    }
  }
  output.push({ ...route[route.length - 1] });
  return output;
}

type SimplifiedRoutePoint = {
  route_type: string;
  x: number;
  y: number;
  width: number;
  layer: string;
};
