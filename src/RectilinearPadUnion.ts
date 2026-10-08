import { applyToPoint, rotateDEG, type Matrix } from "transformation-matrix";
import { distancePointToSegment } from "./geometry";
import type { Obstacle, Point } from "./types";

const GEOMETRY_EPSILON = 1e-9;
const ROTATION_EPSILON_DEGREES = 1e-7;

type Interval = {
  minimum: number;
  maximum: number;
};

type LocalRect = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

type BoundarySegment = {
  start: Point;
  end: Point;
};

type RectilinearComponent = {
  rectangles: LocalRect[];
  boundarySegments?: BoundarySegment[];
};

const normalizeHalfTurnDegrees = (ccwRotationDegrees: number) =>
  ((ccwRotationDegrees % 180) + 180) % 180;

const getHalfTurnDifferenceDegrees = (first: number, second: number) => {
  const difference = Math.abs(first - second);
  return Math.min(difference, 180 - difference);
};

const mergeIntervals = (intervals: Interval[]): Interval[] => {
  const sortedIntervals = intervals
    .filter(
      (interval) => interval.maximum >= interval.minimum - GEOMETRY_EPSILON,
    )
    .sort((first, second) => first.minimum - second.minimum);
  const mergedIntervals: Interval[] = [];
  for (const interval of sortedIntervals) {
    const previous = mergedIntervals.at(-1);
    if (previous && interval.minimum <= previous.maximum + GEOMETRY_EPSILON) {
      previous.maximum = Math.max(previous.maximum, interval.maximum);
    } else {
      mergedIntervals.push({ ...interval });
    }
  }
  return mergedIntervals;
};

const subtractIntervals = (
  interval: Interval,
  coveredIntervals: Interval[],
): Interval[] => {
  const uncoveredIntervals: Interval[] = [];
  let cursor = interval.minimum;
  for (const covered of mergeIntervals(coveredIntervals)) {
    const coveredMinimum = Math.max(interval.minimum, covered.minimum);
    const coveredMaximum = Math.min(interval.maximum, covered.maximum);
    if (coveredMaximum <= cursor + GEOMETRY_EPSILON) continue;
    if (coveredMinimum > cursor + GEOMETRY_EPSILON) {
      uncoveredIntervals.push({
        minimum: cursor,
        maximum: coveredMinimum,
      });
    }
    cursor = Math.max(cursor, coveredMaximum);
    if (cursor >= interval.maximum - GEOMETRY_EPSILON) break;
  }
  if (cursor < interval.maximum - GEOMETRY_EPSILON) {
    uncoveredIntervals.push({ minimum: cursor, maximum: interval.maximum });
  }
  return uncoveredIntervals;
};

const rectanglesTouch = (first: LocalRect, second: LocalRect) =>
  first.minX <= second.maxX + GEOMETRY_EPSILON &&
  first.maxX >= second.minX - GEOMETRY_EPSILON &&
  first.minY <= second.maxY + GEOMETRY_EPSILON &&
  first.maxY >= second.minY - GEOMETRY_EPSILON;

const pointIsInsideRect = (point: Point, rectangle: LocalRect) =>
  point.x >= rectangle.minX - GEOMETRY_EPSILON &&
  point.x <= rectangle.maxX + GEOMETRY_EPSILON &&
  point.y >= rectangle.minY - GEOMETRY_EPSILON &&
  point.y <= rectangle.maxY + GEOMETRY_EPSILON;

const getLineIntervalInsideRect = ({
  origin,
  direction,
  rectangle,
}: {
  origin: Point;
  direction: Point;
  rectangle: LocalRect;
}): Interval | null => {
  let minimum = Number.NEGATIVE_INFINITY;
  let maximum = Number.POSITIVE_INFINITY;
  const axes = [
    {
      originCoordinate: origin.x,
      directionCoordinate: direction.x,
      lowerBound: rectangle.minX,
      upperBound: rectangle.maxX,
    },
    {
      originCoordinate: origin.y,
      directionCoordinate: direction.y,
      lowerBound: rectangle.minY,
      upperBound: rectangle.maxY,
    },
  ];
  for (const axis of axes) {
    if (Math.abs(axis.directionCoordinate) <= GEOMETRY_EPSILON) {
      if (
        axis.originCoordinate < axis.lowerBound - GEOMETRY_EPSILON ||
        axis.originCoordinate > axis.upperBound + GEOMETRY_EPSILON
      ) {
        return null;
      }
      continue;
    }
    const firstIntersection =
      (axis.lowerBound - axis.originCoordinate) / axis.directionCoordinate;
    const secondIntersection =
      (axis.upperBound - axis.originCoordinate) / axis.directionCoordinate;
    minimum = Math.max(
      minimum,
      Math.min(firstIntersection, secondIntersection),
    );
    maximum = Math.min(
      maximum,
      Math.max(firstIntersection, secondIntersection),
    );
    if (minimum > maximum + GEOMETRY_EPSILON) return null;
  }
  return { minimum, maximum };
};

const getConnectedComponents = (rectangles: LocalRect[]): LocalRect[][] => {
  const visited = new Uint8Array(rectangles.length);
  const components: LocalRect[][] = [];
  for (
    let rectangleIndex = 0;
    rectangleIndex < rectangles.length;
    rectangleIndex++
  ) {
    if (visited[rectangleIndex]) continue;
    visited[rectangleIndex] = 1;
    const pendingIndices = [rectangleIndex];
    const component: LocalRect[] = [];
    while (pendingIndices.length > 0) {
      const currentIndex = pendingIndices.pop();
      if (currentIndex === undefined) continue;
      const current = rectangles[currentIndex];
      if (!current) continue;
      component.push(current);
      for (
        let candidateIndex = 0;
        candidateIndex < rectangles.length;
        candidateIndex++
      ) {
        const candidate = rectangles[candidateIndex];
        if (
          visited[candidateIndex] ||
          !candidate ||
          !rectanglesTouch(current, candidate)
        ) {
          continue;
        }
        visited[candidateIndex] = 1;
        pendingIndices.push(candidateIndex);
      }
    }
    components.push(component);
  }
  return components;
};

const getVerticalBoundarySegments = ({
  rectangle,
  rectangles,
  side,
}: {
  rectangle: LocalRect;
  rectangles: LocalRect[];
  side: "left" | "right";
}): BoundarySegment[] => {
  const x = side === "left" ? rectangle.minX : rectangle.maxX;
  const coveredIntervals = rectangles.flatMap((candidate) => {
    if (candidate === rectangle) return [];
    const coversOutside =
      side === "left"
        ? candidate.minX < x - GEOMETRY_EPSILON &&
          candidate.maxX >= x - GEOMETRY_EPSILON
        : candidate.maxX > x + GEOMETRY_EPSILON &&
          candidate.minX <= x + GEOMETRY_EPSILON;
    if (!coversOutside) return [];
    const minimum = Math.max(rectangle.minY, candidate.minY);
    const maximum = Math.min(rectangle.maxY, candidate.maxY);
    return maximum > minimum + GEOMETRY_EPSILON ? [{ minimum, maximum }] : [];
  });
  return subtractIntervals(
    { minimum: rectangle.minY, maximum: rectangle.maxY },
    coveredIntervals,
  ).map((interval) => ({
    start: { x, y: interval.minimum },
    end: { x, y: interval.maximum },
  }));
};

const getHorizontalBoundarySegments = ({
  rectangle,
  rectangles,
  side,
}: {
  rectangle: LocalRect;
  rectangles: LocalRect[];
  side: "bottom" | "top";
}): BoundarySegment[] => {
  const y = side === "bottom" ? rectangle.minY : rectangle.maxY;
  const coveredIntervals = rectangles.flatMap((candidate) => {
    if (candidate === rectangle) return [];
    const coversOutside =
      side === "bottom"
        ? candidate.minY < y - GEOMETRY_EPSILON &&
          candidate.maxY >= y - GEOMETRY_EPSILON
        : candidate.maxY > y + GEOMETRY_EPSILON &&
          candidate.minY <= y + GEOMETRY_EPSILON;
    if (!coversOutside) return [];
    const minimum = Math.max(rectangle.minX, candidate.minX);
    const maximum = Math.min(rectangle.maxX, candidate.maxX);
    return maximum > minimum + GEOMETRY_EPSILON ? [{ minimum, maximum }] : [];
  });
  return subtractIntervals(
    { minimum: rectangle.minX, maximum: rectangle.maxX },
    coveredIntervals,
  ).map((interval) => ({
    start: { x: interval.minimum, y },
    end: { x: interval.maximum, y },
  }));
};

const getBoundarySegments = (rectangles: LocalRect[]): BoundarySegment[] =>
  rectangles.flatMap((rectangle) => [
    ...getVerticalBoundarySegments({ rectangle, rectangles, side: "left" }),
    ...getVerticalBoundarySegments({ rectangle, rectangles, side: "right" }),
    ...getHorizontalBoundarySegments({
      rectangle,
      rectangles,
      side: "bottom",
    }),
    ...getHorizontalBoundarySegments({ rectangle, rectangles, side: "top" }),
  ]);

/**
 * Exact geometry queries for the rectangular fragments that represent one
 * physical pad. All fragments are transformed into a common local frame so
 * internal fragment edges do not constrain the trace neck.
 */
export class RectilinearPadUnion {
  private readonly worldToPadLocalTransform: Matrix;
  private readonly components: RectilinearComponent[];

  private constructor(
    obstacles: readonly Obstacle[],
    ccwRotationDegrees: number,
  ) {
    this.worldToPadLocalTransform = rotateDEG(-ccwRotationDegrees);
    const rectangles = obstacles.map((obstacle) => {
      const center = this.toLocalPoint(obstacle.center);
      return {
        minX: center.x - obstacle.width / 2,
        minY: center.y - obstacle.height / 2,
        maxX: center.x + obstacle.width / 2,
        maxY: center.y + obstacle.height / 2,
      };
    });
    this.components = getConnectedComponents(rectangles).map((rectangles) => ({
      rectangles,
    }));
  }

  static create(obstacles: readonly Obstacle[]): RectilinearPadUnion | null {
    if (
      obstacles.length < 2 ||
      obstacles.some((obstacle) => obstacle.type !== "rect")
    ) {
      return null;
    }
    const firstObstacle = obstacles[0];
    if (!firstObstacle) return null;
    const normalizedCcwRotationDegrees = normalizeHalfTurnDegrees(
      firstObstacle.ccwRotationDegrees ?? 0,
    );
    if (
      obstacles.some(
        (obstacle) =>
          getHalfTurnDifferenceDegrees(
            normalizeHalfTurnDegrees(obstacle.ccwRotationDegrees ?? 0),
            normalizedCcwRotationDegrees,
          ) > ROTATION_EPSILON_DEGREES,
      )
    ) {
      return null;
    }
    return new RectilinearPadUnion(obstacles, normalizedCcwRotationDegrees);
  }

  getSymmetricWidthAtPoint({
    point,
    segmentStart,
    segmentEnd,
  }: {
    point: Point;
    segmentStart: Point;
    segmentEnd: Point;
  }): number | null {
    const deltaX = segmentEnd.x - segmentStart.x;
    const deltaY = segmentEnd.y - segmentStart.y;
    const length = Math.hypot(deltaX, deltaY);
    if (length <= GEOMETRY_EPSILON) return null;
    const localPoint = this.toLocalPoint(point);
    const localNormal = this.toLocalDirection({
      x: -deltaY / length,
      y: deltaX / length,
    });
    const component = this.getComponentAtPoint(localPoint);
    if (!component) return null;
    const intervals = mergeIntervals(
      component.rectangles.flatMap((rectangle) => {
        const interval = getLineIntervalInsideRect({
          origin: localPoint,
          direction: localNormal,
          rectangle,
        });
        return interval ? [interval] : [];
      }),
    );
    const containingInterval = intervals.find(
      (interval) =>
        interval.minimum <= GEOMETRY_EPSILON &&
        interval.maximum >= -GEOMETRY_EPSILON,
    );
    if (!containingInterval) return null;
    return (
      2 *
      Math.max(
        0,
        Math.min(-containingInterval.minimum, containingInterval.maximum),
      )
    );
  }

  getCenteredCircleDiameter(point: Point): number | null {
    const localPoint = this.toLocalPoint(point);
    const component = this.getComponentAtPoint(localPoint);
    if (!component) return null;
    component.boundarySegments ??= getBoundarySegments(component.rectangles);
    if (component.boundarySegments.length === 0) return null;
    const radius = Math.min(
      ...component.boundarySegments.map((segment) =>
        distancePointToSegment(localPoint, segment.start, segment.end),
      ),
    );
    return Math.max(0, radius * 2);
  }

  getExitPoint({
    inside,
    outside,
  }: {
    inside: Point;
    outside: Point;
  }): Point | null {
    const localInside = this.toLocalPoint(inside);
    const localOutside = this.toLocalPoint(outside);
    const component = this.getComponentAtPoint(localInside);
    if (!component) return null;
    const direction = {
      x: localOutside.x - localInside.x,
      y: localOutside.y - localInside.y,
    };
    const intervals = mergeIntervals(
      component.rectangles.flatMap((rectangle) => {
        const interval = getLineIntervalInsideRect({
          origin: localInside,
          direction,
          rectangle,
        });
        if (!interval) return [];
        const minimum = Math.max(0, interval.minimum);
        const maximum = Math.min(1, interval.maximum);
        return maximum >= minimum - GEOMETRY_EPSILON
          ? [{ minimum, maximum }]
          : [];
      }),
    );
    const containingInterval = intervals.find(
      (interval) =>
        interval.minimum <= GEOMETRY_EPSILON &&
        interval.maximum >= -GEOMETRY_EPSILON,
    );
    if (
      !containingInterval ||
      containingInterval.maximum >= 1 - GEOMETRY_EPSILON
    ) {
      return null;
    }
    return {
      x: inside.x + (outside.x - inside.x) * containingInterval.maximum,
      y: inside.y + (outside.y - inside.y) * containingInterval.maximum,
    };
  }

  private getComponentAtPoint(localPoint: Point) {
    return this.components.find((component) =>
      component.rectangles.some((rectangle) =>
        pointIsInsideRect(localPoint, rectangle),
      ),
    );
  }

  private toLocalPoint(point: Point): Point {
    return applyToPoint(this.worldToPadLocalTransform, point);
  }

  private toLocalDirection(direction: Point): Point {
    return this.toLocalPoint(direction);
  }
}
