import { distance, pointsEqual, WIDTH_EPSILON } from "./geometry";
import type { Point } from "./types";

export const isOctilinearSegment = (start: Point, end: Point) => {
  const deltaX = Math.abs(end.x - start.x);
  const deltaY = Math.abs(end.y - start.y);
  return (
    deltaX <= WIDTH_EPSILON ||
    deltaY <= WIDTH_EPSILON ||
    Math.abs(deltaX - deltaY) <= WIDTH_EPSILON
  );
};

export const countNonOctilinearSegments = (points: Point[]) => {
  let count = 0;
  for (let index = 0; index < points.length - 1; index++) {
    if (!isOctilinearSegment(points[index]!, points[index + 1]!)) count++;
  }
  return count;
};

export const getPathLength = (points: Point[]) => {
  let length = 0;
  for (let index = 0; index < points.length - 1; index++) {
    length += distance(points[index]!, points[index + 1]!);
  }
  return length;
};

const removeDuplicatePoints = (points: Point[]) =>
  points.filter(
    (point, index) => index === 0 || !pointsEqual(point, points[index - 1]!),
  );

/**
 * Returns the compact 0/45/90-degree paths used by the autorouter's path
 * simplifier. Direct, one-bend Manhattan, and one-bend diagonal variants are
 * deliberately kept separate so an obstacle index can rank them cheaply.
 */
export const calculateOctilinearPaths = (start: Point, end: Point) => {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const absoluteX = Math.abs(deltaX);
  const absoluteY = Math.abs(deltaY);
  const signX = Math.sign(deltaX);
  const signY = Math.sign(deltaY);
  const candidates: Point[][] = [];

  if (isOctilinearSegment(start, end)) candidates.push([start, end]);
  candidates.push(
    [start, { x: end.x, y: start.y }, end],
    [start, { x: start.x, y: end.y }, end],
  );

  if (absoluteX >= absoluteY) {
    candidates.push(
      [start, { x: end.x - signX * absoluteY, y: start.y }, end],
      [start, { x: start.x + signX * absoluteY, y: end.y }, end],
    );
  } else {
    candidates.push(
      [start, { x: start.x, y: end.y - signY * absoluteX }, end],
      [start, { x: end.x, y: start.y + signY * absoluteX }, end],
    );
  }

  const uniquePaths = new Map<string, Point[]>();
  for (const candidate of candidates) {
    const path = removeDuplicatePoints(candidate);
    if (
      path.length < 2 ||
      path.some(
        (point, index) =>
          index < path.length - 1 &&
          !isOctilinearSegment(point, path[index + 1]!),
      )
    ) {
      continue;
    }
    const key = path
      .map((point) => `${point.x.toFixed(6)},${point.y.toFixed(6)}`)
      .join(";");
    uniquePaths.set(key, path);
  }
  return [...uniquePaths.values()].sort(
    (a, b) => getPathLength(a) - getPathLength(b) || a.length - b.length,
  );
};

function getSpineEntries(
  {
    anchor,
    spineCross,
    alongSign,
  }: {
    anchor: Point;
    spineCross: number;
    alongSign: number;
  },
  traceWidth: number,
): [Point, Point][] {
  const crossDistance = spineCross - anchor.x;
  const entries = [0.25, 0.5, 0.75, 1].map(
    (diagonalFraction): [Point, Point] => {
      const diagonal = crossDistance * diagonalFraction;
      return [
        { x: spineCross - diagonal, y: anchor.y },
        { x: spineCross, y: anchor.y + Math.abs(diagonal) * alongSign },
      ];
    },
  );
  for (const leadLength of [traceWidth / 4, traceWidth / 2, traceWidth]) {
    entries.push([
      { x: anchor.x, y: anchor.y + leadLength * alongSign },
      {
        x: spineCross,
        y: anchor.y + (leadLength + Math.abs(crossDistance)) * alongSign,
      },
    ]);
  }
  return entries;
}

function swapPointAxes(point: Point): Point {
  return { x: point.y, y: point.x };
}

export function hasShortAxisDetour(
  points: Point[],
  maxOffset: number,
): boolean {
  return points.slice(1, -1).some((point, index) => {
    const start = points[index]!;
    const end = points[index + 2]!;
    if (isOctilinearSegment(start, point) && isOctilinearSegment(point, end))
      return false;

    for (const axis of ["x", "y"] as const) {
      const offset = Math.abs(point[axis] - start[axis]);
      if (
        Math.abs(start[axis] - end[axis]) <= WIDTH_EPSILON &&
        offset > WIDTH_EPSILON &&
        offset <= maxOffset
      )
        return true;
    }
    return false;
  });
}

/** Try one straight run around the existing detour with 45-degree transitions. */
export function calculateOctilinearSpinePaths(
  points: Point[],
  traceWidth: number,
): Point[][] {
  const first = points[0]!;
  const last = points.at(-1)!;
  const swapAxes = Math.abs(last.x - first.x) > Math.abs(last.y - first.y);
  let oriented = points;
  if (swapAxes) oriented = points.map(swapPointAxes);
  const start = oriented[0]!;
  const end = oriented.at(-1)!;
  const alongSign = Math.sign(end.y - start.y);
  const paths: Point[][] = [];

  for (const side of [-1, 1]) {
    const outerCross =
      side * Math.max(...oriented.map((point) => side * point.x));
    for (const offset of [0, traceWidth / 4, traceWidth / 2]) {
      const spineCross = outerCross + side * offset;
      const startEntries = getSpineEntries(
        { anchor: start, spineCross, alongSign },
        traceWidth,
      );
      const endEntries = getSpineEntries(
        { anchor: end, spineCross, alongSign: -alongSign },
        traceWidth,
      );
      for (const [firstCorner, firstSpinePoint] of startEntries) {
        for (const [lastCorner, lastSpinePoint] of endEntries) {
          if (
            (lastSpinePoint.y - firstSpinePoint.y) * alongSign <=
            WIDTH_EPSILON
          )
            continue;
          paths.push(
            removeDuplicatePoints([
              start,
              firstCorner,
              firstSpinePoint,
              lastSpinePoint,
              lastCorner,
              end,
            ]),
          );
        }
      }
    }
  }
  paths.sort(
    (a, b) => a.length - b.length || getPathLength(a) - getPathLength(b),
  );
  if (swapAxes) return paths.map((path) => path.map(swapPointAxes));
  return paths;
}
