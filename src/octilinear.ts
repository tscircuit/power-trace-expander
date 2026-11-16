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

function getDetourCorners(
  {
    start,
    laneX,
    direction,
  }: { start: Point; laneX: number; direction: number },
  width: number,
): [Point, Point][] {
  const dx = laneX - start.x;
  const corners = [1, 0.5, 0.25].map((fraction): [Point, Point] => [
    { x: laneX - dx * fraction, y: start.y },
    { x: laneX, y: start.y + Math.abs(dx * fraction) * direction },
  ]);
  const lead = width / 4;
  corners.push([
    { x: start.x, y: start.y + lead * direction },
    { x: laneX, y: start.y + (lead + Math.abs(dx)) * direction },
  ]);
  return corners;
}

function swapAxes({ x, y }: Point): Point {
  return { x: y, y: x };
}

/** Replace a small lateral excursion with a straight run on the same side. */
export function* getShortDetourReplacements(
  points: Point[],
  width: number,
): Generator<Point[]> {
  const first = points[0]!;
  const last = points.at(-1)!;
  const horizontal = Math.abs(last.x - first.x) > Math.abs(last.y - first.y);
  let route = points;
  if (horizontal) route = points.map(swapAxes);
  const start = route[0]!;
  const end = route.at(-1)!;
  const direction = Math.sign(end.y - start.y);
  if (direction === 0) return;

  const sides = new Set<number>();
  for (let index = 1; index < route.length - 1; index++) {
    const before = route[index - 1]!;
    const bend = route[index]!;
    const after = route[index + 1]!;
    const offset = bend.x - before.x;
    if (
      Math.abs(before.x - after.x) <= WIDTH_EPSILON &&
      Math.abs(offset) > WIDTH_EPSILON &&
      Math.abs(offset) <= width &&
      (bend.y - before.y) * (after.y - bend.y) > 0 &&
      (!isOctilinearSegment(before, bend) || !isOctilinearSegment(bend, after))
    ) {
      sides.add(Math.sign(offset));
    }
  }

  for (const side of sides) {
    const edge = route.reduce(
      (outer, point) => Math.max(outer, point.x * side),
      -Infinity,
    );
    for (const offset of [0, width / 4, width / 2]) {
      const laneX = (edge + offset) * side;
      const fromStart = getDetourCorners({ start, laneX, direction }, width);
      const fromEnd = getDetourCorners(
        { start: end, laneX, direction: -direction },
        width,
      );
      for (const [first, entry] of fromStart) {
        for (const [last, exit] of fromEnd) {
          if ((exit.y - entry.y) * direction <= WIDTH_EPSILON) continue;

          let path = removeDuplicatePoints([
            start,
            first,
            entry,
            exit,
            last,
            end,
          ]);
          if (horizontal) path = path.map(swapAxes);
          yield path;
        }
      }
    }
  }
}
