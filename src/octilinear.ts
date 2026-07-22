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
