import { BaseSolver } from "@tscircuit/solver-utils";
import type { GraphicsObject } from "graphics-debug";
import { clamp, distance, pointsEqual } from "./geometry";
import type {
  ElasticTracePushOutput,
  ElasticTracePushProblem,
  InflationCorridorSegment,
  Point,
} from "./types";

type ElasticPhase =
  | "prepare-candidate"
  | "relax-candidate"
  | "validate-candidate"
  | "complete";

const CANDIDATE_VARIANTS = [
  { direction: 1, strength: 0.7 },
  { direction: -1, strength: 0.7 },
  { direction: 1, strength: 1 },
  { direction: -1, strength: 1 },
] as const;

const closestPointOnSegment = (point: Point, start: Point, end: Point) => {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const lengthSquared = deltaX * deltaX + deltaY * deltaY;
  if (lengthSquared <= 1e-12) return { ...start };
  const t = clamp(
    ((point.x - start.x) * deltaX + (point.y - start.y) * deltaY) /
      lengthSquared,
    0,
    1,
  );
  return { x: start.x + deltaX * t, y: start.y + deltaY * t };
};

/**
 * Applies a small, smooth displacement to a blocking trace before falling
 * back to A*. Each relaxation pass is one debugger step, so the inflation
 * force and its eventual acceptance remain inspectable.
 */
export class ElasticTracePushSolver extends BaseSolver {
  readonly problem: ElasticTracePushProblem;
  phase: ElasticPhase = "prepare-candidate";
  variantCursor = 0;
  relaxationIteration = 0;
  candidatePoints: Point[] = [];

  private readonly sampledPoints: Point[];
  private output: ElasticTracePushOutput | null = null;

  constructor(problem: ElasticTracePushProblem) {
    super();
    this.problem = problem;
    this.sampledPoints = this.sampleRoute();
    this.MAX_ITERATIONS = 100;
    this.stats = this.createStats();
  }

  override getSolverName() {
    return "ElasticTracePushSolver";
  }

  override _step() {
    switch (this.phase) {
      case "prepare-candidate":
        if (this.variantCursor >= CANDIDATE_VARIANTS.length) {
          this.failed = true;
          this.error = "No collision-free elastic displacement found";
          return;
        }
        this.candidatePoints = this.sampledPoints.map((point) => ({
          ...point,
        }));
        this.relaxationIteration = 0;
        this.phase = "relax-candidate";
        break;
      case "relax-candidate":
        this.relaxCandidate();
        this.relaxationIteration++;
        if (this.relaxationIteration >= 10) {
          this.phase = "validate-candidate";
        }
        break;
      case "validate-candidate": {
        const simplified = this.simplifyCandidate(this.candidatePoints);
        if (!this.pathCollides(simplified)) {
          this.output = {
            points: simplified,
            traceWidth: this.problem.traceWidth,
          };
          this.phase = "complete";
        } else {
          this.variantCursor++;
          this.phase = "prepare-candidate";
        }
        break;
      }
      case "complete":
        this.solved = true;
        break;
    }
    this.stats = this.createStats();
  }

  private sampleRoute() {
    const points: Point[] = [];
    const spacing = clamp(this.problem.traceWidth * 2, 0.2, 0.45);
    const route = this.problem.trace.route;
    for (
      let index = this.problem.range.startIndex;
      index < this.problem.range.endIndex;
      index++
    ) {
      const start = route[index];
      const end = route[index + 1];
      if (
        start?.route_type !== "wire" ||
        end?.route_type !== "wire" ||
        start.layer !== end.layer
      )
        continue;
      if (points.length === 0) points.push({ x: start.x, y: start.y });
      const segmentLength = distance(start, end);
      const sampleCount = Math.max(1, Math.ceil(segmentLength / spacing));
      for (let sample = 1; sample <= sampleCount; sample++) {
        const t = sample / sampleCount;
        points.push({
          x: start.x + (end.x - start.x) * t,
          y: start.y + (end.y - start.y) * t,
        });
      }
    }
    return points;
  }

  private relaxCandidate() {
    const variant = CANDIDATE_VARIANTS[this.variantCursor]!;
    const nextPoints = this.candidatePoints.map((point) => ({ ...point }));
    const moved = new Uint8Array(this.candidatePoints.length);

    for (let index = 1; index < this.candidatePoints.length - 1; index++) {
      const point = this.candidatePoints[index]!;
      const nearest = this.findNearestCorridorSegment(point);
      if (!nearest) continue;
      const segmentLength = distance(
        nearest.segment.start,
        nearest.segment.end,
      );
      if (segmentLength <= 1e-9) continue;
      const requiredDistance =
        nearest.segment.width / 2 +
        this.problem.traceWidth / 2 +
        this.problem.obstacleIndex.clearance +
        0.025;
      if (nearest.distance > requiredDistance + 0.35) continue;
      const normal = {
        x:
          ((nearest.segment.start.y - nearest.segment.end.y) / segmentLength) *
          variant.direction,
        y:
          ((nearest.segment.end.x - nearest.segment.start.x) / segmentLength) *
          variant.direction,
      };
      const signedDistance =
        (point.x - nearest.closest.x) * normal.x +
        (point.y - nearest.closest.y) * normal.y;
      const penetration = requiredDistance - signedDistance;
      if (penetration <= 0) continue;
      const step = Math.min(0.35, penetration * variant.strength);
      nextPoints[index] = {
        x: point.x + normal.x * step,
        y: point.y + normal.y * step,
      };
      moved[index] = 1;
    }

    for (let index = 1; index < nextPoints.length - 1; index++) {
      if (!moved[index]) continue;
      const previous = nextPoints[index - 1]!;
      const current = nextPoints[index]!;
      const next = nextPoints[index + 1]!;
      nextPoints[index] = {
        x: current.x * 0.85 + ((previous.x + next.x) / 2) * 0.15,
        y: current.y * 0.85 + ((previous.y + next.y) / 2) * 0.15,
      };
    }
    this.candidatePoints = nextPoints;
  }

  private findNearestCorridorSegment(point: Point) {
    let nearest:
      | {
          segment: InflationCorridorSegment;
          closest: Point;
          distance: number;
        }
      | undefined;
    for (const segment of this.problem.corridor) {
      if (segment.layer !== this.problem.layer) continue;
      const closest = closestPointOnSegment(point, segment.start, segment.end);
      const pointDistance = distance(point, closest);
      if (!nearest || pointDistance < nearest.distance) {
        nearest = { segment, closest, distance: pointDistance };
      }
    }
    return nearest;
  }

  private simplifyCandidate(points: Point[]) {
    if (points.length <= 2) return points;
    const simplified = [points[0]!];
    let anchorIndex = 0;
    while (anchorIndex < points.length - 1) {
      let nextIndex = points.length - 1;
      while (
        nextIndex > anchorIndex + 1 &&
        this.segmentCollides(points[anchorIndex]!, points[nextIndex]!)
      ) {
        nextIndex--;
      }
      simplified.push(points[nextIndex]!);
      anchorIndex = nextIndex;
    }
    return simplified.filter(
      (point, index, allPoints) =>
        index === 0 || !pointsEqual(point, allPoints[index - 1]!),
    );
  }

  private pathCollides(points: Point[]) {
    if (points.length < 2) return true;
    for (let index = 0; index < points.length - 1; index++) {
      if (this.segmentCollides(points[index]!, points[index + 1]!)) return true;
    }
    return false;
  }

  private segmentCollides(start: Point, end: Point) {
    return this.problem.obstacleIndex.collides({
      start,
      end,
      layer: this.problem.layer,
      width: this.problem.traceWidth,
      connectionNames: this.problem.connectionNames,
      ignoreTraceIndex: -1,
    });
  }

  private createStats() {
    const variant = CANDIDATE_VARIANTS[this.variantCursor];
    return {
      phase: this.phase,
      direction: variant?.direction,
      strength: variant?.strength,
      variantCursor: this.variantCursor,
      relaxationIteration: this.relaxationIteration,
      sampledPointCount: this.sampledPoints.length,
    };
  }

  computeProgress() {
    return Math.min(
      0.99,
      (this.variantCursor + this.relaxationIteration / 12) /
        CANDIDATE_VARIANTS.length,
    );
  }

  override getOutput() {
    return this.output;
  }

  override getConstructorParams() {
    return [this.problem];
  }

  override visualize(): GraphicsObject {
    return {
      coordinateSystem: "cartesian",
      title: `Elastic trace push: ${this.phase}`,
      lines: [
        ...this.problem.corridor.map((segment) => ({
          points: [segment.start, segment.end],
          strokeColor: "rgba(255, 128, 0, 0.6)",
          strokeWidth: segment.width,
        })),
        ...(this.candidatePoints.length > 1
          ? [
              {
                points: this.candidatePoints,
                strokeColor: "#1769d2",
                strokeWidth: this.problem.traceWidth,
              },
            ]
          : []),
      ],
      points: [],
      rects: [],
      circles: [],
      texts: [],
    };
  }
}
