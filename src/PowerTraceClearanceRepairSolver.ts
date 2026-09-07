import { BaseSolver } from "@tscircuit/solver-utils";
import type { GraphicsObject } from "graphics-debug";
import { ConnectionNameResolver } from "./ConnectionNameResolver";
import { WIDTH_EPSILON } from "./geometry";
import { SpatialObstacleIndex } from "./SpatialObstacleIndex";
import type {
  CollisionQuery,
  SimpleRouteJson,
  SimplifiedPcbTrace,
  WireRoutePoint,
} from "./types";

export type PowerTraceClearanceRepairProblem = {
  simpleRouteJson: SimpleRouteJson;
  traces: SimplifiedPcbTrace[];
  /** Restrict repair to these traces while retaining all traces as obstacles. */
  traceIndices?: readonly number[];
};

const isWire = (
  point: SimplifiedPcbTrace["route"][number] | undefined,
): point is WireRoutePoint => point?.route_type === "wire";

const MIN_INSERTED_SEGMENT_LENGTH = 0.001;

/**
 * Final copper-clearance guard using segment-start widths.
 *
 * A wire point owns the width of the segment to the next point. Core preserves
 * this association when reversing routes, so each pad crossing needs only one
 * boundary point and clearance repairs need only narrow the colliding segment.
 */
export class PowerTraceClearanceRepairSolver extends BaseSolver {
  readonly inputProblem: PowerTraceClearanceRepairProblem;
  traces: SimplifiedPcbTrace[];
  obstacleIndex: SpatialObstacleIndex;
  traceCursor = 0;
  routeCursor = 0;
  repairedSegmentCount = 0;
  repairedPadNeckSegmentCount = 0;
  unresolvedSegmentCount = 0;
  totalWidthReduction = 0;
  budgetLimited = false;

  private readonly connectionNameResolver: ConnectionNameResolver;
  private readonly minimumTraceWidth: number;
  private readonly traceIndices: number[];

  constructor(inputProblem: PowerTraceClearanceRepairProblem) {
    super();
    this.inputProblem = structuredClone(inputProblem);
    this.traces = structuredClone(inputProblem.traces);
    this.connectionNameResolver = new ConnectionNameResolver(
      inputProblem.simpleRouteJson,
      this.traces,
    );
    this.minimumTraceWidth = inputProblem.simpleRouteJson.minTraceWidth;
    const requestedIndices = inputProblem.traceIndices
      ? new Set(inputProblem.traceIndices)
      : null;
    this.traceIndices = this.traces.flatMap((_, traceIndex) =>
      !requestedIndices || requestedIndices.has(traceIndex) ? [traceIndex] : [],
    );
    this.obstacleIndex = this.createObstacleIndex();
    const initialSegmentCount = this.traceIndices.reduce(
      (count, traceIndex) =>
        count + Math.max(0, this.traces[traceIndex]!.route.length - 1),
      0,
    );
    // A segment joining two pads can gain two boundary points. Leave enough
    // headroom to recheck the split segments and both trace terminals.
    this.MAX_ITERATIONS = Math.max(
      10,
      initialSegmentCount * 8 + this.traceIndices.length * 2,
    );
    this.stats = this.createStats();
  }

  override getSolverName() {
    return "PowerTraceClearanceRepairSolver";
  }

  override _step() {
    const traceIndex = this.traceIndices[this.traceCursor];
    const trace =
      traceIndex === undefined ? undefined : this.traces[traceIndex];
    if (!trace) {
      this.solved = true;
      this.stats = this.createStats();
      return;
    }
    if (this.routeCursor >= trace.route.length - 1) {
      this.traceCursor++;
      this.routeCursor = 0;
      this.stats = this.createStats();
      return;
    }

    const routeIndex = this.routeCursor++;
    const start = trace.route[routeIndex];
    const end = trace.route[routeIndex + 1];
    if (!isWire(start) || !isWire(end) || start.layer !== end.layer) {
      this.stats = this.createStats();
      return;
    }

    const currentWidth = start.width;
    const padQuery: CollisionQuery = {
      start,
      end,
      layer: start.layer,
      width: currentWidth,
      connectionNames: this.getTraceConnectionNames(trace),
      ignoreTraceIndex: traceIndex,
      ignoreRouteRange: { start: routeIndex, end: routeIndex + 1 },
    };
    if (this.repairConnectedPadNeck(trace, routeIndex, padQuery)) {
      this.stats = this.createStats();
      return;
    }
    if (!this.segmentHasForeignTraceCollision(routeIndex, currentWidth)) {
      this.stats = this.createStats();
      return;
    }
    if (
      this.segmentHasForeignTraceCollision(routeIndex, this.minimumTraceWidth)
    ) {
      this.unresolvedSegmentCount++;
      this.stats = this.createStats();
      return;
    }

    let safeWidth = this.minimumTraceWidth;
    let unsafeWidth = currentWidth;
    for (let probe = 0; probe < 10; probe++) {
      const candidateWidth = (safeWidth + unsafeWidth) / 2;
      if (this.segmentHasForeignTraceCollision(routeIndex, candidateWidth)) {
        unsafeWidth = candidateWidth;
      } else {
        safeWidth = candidateWidth;
      }
    }
    const quantum = currentWidth >= 0.5 ? 0.025 : 0.0125;
    const quantizedSafeWidth = Math.max(
      this.minimumTraceWidth,
      Math.floor((safeWidth + WIDTH_EPSILON) / quantum) * quantum,
    );
    const repairedWidth = this.segmentHasForeignTraceCollision(
      routeIndex,
      quantizedSafeWidth,
    )
      ? safeWidth
      : quantizedSafeWidth;

    const previousStartWidth = start.width;
    start.width = Math.min(start.width, repairedWidth);
    const reduction = previousStartWidth - start.width;
    if (reduction <= WIDTH_EPSILON) {
      this.unresolvedSegmentCount++;
      this.stats = this.createStats();
      return;
    }

    this.repairedSegmentCount++;
    this.totalWidthReduction += reduction;
    this.obstacleIndex = this.createObstacleIndex();
    this.stats = this.createStats();
  }

  private repairConnectedPadNeck(
    trace: SimplifiedPcbTrace,
    routeIndex: number,
    query: CollisionQuery,
  ): boolean {
    const start = trace.route[routeIndex];
    const end = trace.route[routeIndex + 1];
    if (!isWire(start) || !isWire(end)) return false;
    const startNeck = this.obstacleIndex.getConnectedPadNeck(
      query,
      "start",
      routeIndex === 0,
    );
    const endNeck = this.obstacleIndex.getConnectedPadNeck(
      query,
      "end",
      routeIndex + 1 === trace.route.length - 1,
    );
    const startLimit = startNeck?.widthLimit ?? null;
    const endLimit = endNeck?.widthLimit ?? null;
    if (startLimit === null && endLimit === null) return false;
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    const distanceFromStart = (point: { x: number; y: number }) =>
      Math.hypot(point.x - start.x, point.y - start.y);
    const startBoundary = startNeck?.boundary ?? null;
    const endBoundary = endNeck?.boundary ?? null;
    const startExit = startBoundary ? distanceFromStart(startBoundary) : length;
    const endEntry = endBoundary ? distanceFromStart(endBoundary) : 0;

    const originalWidth = start.width;
    let outsideWidth = originalWidth;
    const viaBoundary =
      startLimit !== null &&
      endLimit === null &&
      trace.route[routeIndex + 2]?.route_type === "via"
        ? startBoundary
        : endLimit !== null &&
            startLimit === null &&
            trace.route[routeIndex - 1]?.route_type === "via"
          ? endBoundary
          : null;
    if (viaBoundary) {
      const nominalWidth = this.resolveNominalTraceWidth(trace);
      // Only the outside span is restored. Its owner is the boundary when
      // leaving a pad, and the original start point when entering a pad.
      if (
        nominalWidth > outsideWidth + WIDTH_EPSILON &&
        !this.obstacleIndex.collides({
          ...query,
          start: startLimit !== null ? viaBoundary : start,
          end: startLimit !== null ? end : viaBoundary,
          width: nominalWidth,
        })
      ) {
        outsideWidth = nominalWidth;
      }
    }

    const boundaries = [
      ...(startLimit !== null && startBoundary ? [startBoundary] : []),
      ...(endLimit !== null && endBoundary ? [endBoundary] : []),
    ].sort((a, b) => distanceFromStart(a) - distanceFromStart(b));
    const points = [start, ...boundaries, end];
    const spans = points.slice(0, -1).map((point, index) => {
      const next = points[index + 1]!;
      const middle = (distanceFromStart(point) + distanceFromStart(next)) / 2;
      let width = outsideWidth;
      // Pads may be narrower than the global minimum trace width. Preserve
      // their physical neck limits, including when both pads share a segment.
      if (startLimit !== null && middle <= startExit) {
        width = Math.min(width, originalWidth, startLimit);
      }
      if (endLimit !== null && middle >= endEntry) {
        width = Math.min(width, originalWidth, endLimit);
      }
      return { start: point, end: next, width };
    });

    const coalesceEqualWidthSpans = () => {
      for (let index = 1; index < spans.length; ) {
        const previous = spans[index - 1]!;
        const current = spans[index]!;
        if (Math.abs(previous.width - current.width) <= WIDTH_EPSILON) {
          previous.end = current.end;
          previous.width = Math.min(previous.width, current.width);
          spans.splice(index, 1);
        } else {
          index++;
        }
      }
    };
    // Coincident pad boundaries can create a zero-length narrow span. Join it
    // to an equal-width neighbor before it can consume valid wider copper.
    coalesceEqualWidthSpans();

    // Remove only proposed splits. If a split would create a sub-micron span,
    // extend the narrower adjoining width across it. Existing short segments
    // and their endpoints remain untouched.
    for (let index = 0; spans.length > 1 && index < spans.length; ) {
      const span = spans[index]!;
      const spanLength = Math.hypot(
        span.end.x - span.start.x,
        span.end.y - span.start.y,
      );
      if (spanLength >= MIN_INSERTED_SEGMENT_LENGTH) {
        index++;
        continue;
      }
      const previousIndex = index === 0 ? 0 : index - 1;
      const left = spans[previousIndex]!;
      const right = spans[previousIndex + 1]!;
      spans.splice(previousIndex, 2, {
        start: left.start,
        end: right.end,
        width: Math.min(left.width, right.width),
      });
      index = previousIndex;
    }
    coalesceEqualWidthSpans();
    if (
      spans.length === 1 &&
      Math.abs(spans[0]!.width - originalWidth) <= WIDTH_EPSILON
    ) {
      return false;
    }

    start.width = spans[0]!.width;
    trace.route.splice(
      routeIndex + 1,
      0,
      ...spans.slice(1).map(
        (span): WireRoutePoint => ({
          route_type: "wire",
          x: span.start.x,
          y: span.start.y,
          width: span.width,
          layer: query.layer,
        }),
      ),
    );
    this.totalWidthReduction += spans.reduce(
      (reduction, span) => reduction + Math.max(0, originalWidth - span.width),
      0,
    );
    this.repairedPadNeckSegmentCount++;
    this.obstacleIndex = this.createObstacleIndex();
    this.routeCursor = routeIndex;
    return true;
  }

  private resolveNominalTraceWidth(trace: SimplifiedPcbTrace): number {
    const traceNames = new Set(
      this.connectionNameResolver.canonicalize(
        this.getTraceConnectionNames(trace),
      ),
    );
    const connection = this.inputProblem.simpleRouteJson.connections.find(
      (candidate) =>
        this.connectionNameResolver
          .canonicalize(
            [
              candidate.name,
              candidate.source_trace_id,
              candidate.rootConnectionName,
              ...(candidate.mergedConnectionNames ?? []),
            ].filter((name): name is string => Boolean(name)),
          )
          .some((name) => traceNames.has(name)),
    );
    return Math.max(
      connection?.nominalTraceWidth ??
        connection?.width ??
        this.inputProblem.simpleRouteJson.nominalTraceWidth ??
        this.minimumTraceWidth,
      this.minimumTraceWidth,
    );
  }

  private segmentHasForeignTraceCollision(routeIndex: number, width: number) {
    const traceIndex = this.traceIndices[this.traceCursor];
    const trace =
      traceIndex === undefined ? undefined : this.traces[traceIndex];
    const start = trace?.route[routeIndex];
    const end = trace?.route[routeIndex + 1];
    if (!trace || !isWire(start) || !isWire(end) || start.layer !== end.layer) {
      return false;
    }
    return this.obstacleIndex
      .findCollisions({
        start,
        end,
        layer: start.layer,
        width,
        connectionNames: this.getTraceConnectionNames(trace),
        ignoreTraceIndex: traceIndex,
        ignoreRouteRange: {
          start: routeIndex,
          end: routeIndex + 1,
        },
      })
      .some(
        (collision) =>
          collision.kind === "trace" &&
          collision.traceIndex !== undefined &&
          collision.traceIndex !== traceIndex,
      );
  }

  private createObstacleIndex() {
    return new SpatialObstacleIndex(
      this.inputProblem.simpleRouteJson,
      this.traces,
      undefined,
      [],
      this.connectionNameResolver,
    );
  }

  private getTraceConnectionNames(trace: SimplifiedPcbTrace) {
    return [
      trace.pcb_trace_id,
      trace.connection_name,
      trace.source_trace_id,
      trace.rootConnectionName,
      ...(trace.mergedConnectionNames ?? []),
      ...(trace.connectsTo ?? []),
    ].filter((name): name is string => Boolean(name));
  }

  private createStats() {
    return {
      phase: this.solved ? "complete" : "repair-trace-clearance",
      budgetLimited: this.budgetLimited,
      completionReason: this.solved
        ? this.budgetLimited
          ? "iteration_budget"
          : "completed"
        : null,
      traceCursor: this.traceCursor,
      traceCount: this.traceIndices.length,
      traceIndex: this.traceIndices[this.traceCursor],
      routeCursor: this.routeCursor,
      repairedSegmentCount: this.repairedSegmentCount,
      repairedPadNeckSegmentCount: this.repairedPadNeckSegmentCount,
      unresolvedSegmentCount: this.unresolvedSegmentCount,
      totalWidthReduction: this.totalWidthReduction,
      spatialIndexRectCount: this.obstacleIndex.items.length,
    };
  }

  computeProgress() {
    if (this.solved) return 1;
    if (this.traceIndices.length === 0) return 1;
    return Math.min(0.99, this.traceCursor / this.traceIndices.length);
  }

  override tryFinalAcceptance() {
    // Every repair step is atomic, so `traces` always contains a safe committed
    // prefix of the full clearance-repair pass.
    this.budgetLimited = true;
    this.solved = true;
    this.progress = 1;
    this.stats = this.createStats();
  }

  override getConstructorParams() {
    return [this.inputProblem];
  }

  override getOutput() {
    return this.traces;
  }

  override visualize(): GraphicsObject {
    const lines: NonNullable<GraphicsObject["lines"]> = [];
    for (let traceIndex = 0; traceIndex < this.traces.length; traceIndex++) {
      const trace = this.traces[traceIndex]!;
      for (
        let routeIndex = 0;
        routeIndex < trace.route.length - 1;
        routeIndex++
      ) {
        const start = trace.route[routeIndex];
        const end = trace.route[routeIndex + 1];
        if (!isWire(start) || !isWire(end) || start.layer !== end.layer) {
          continue;
        }
        lines.push({
          points: [start, end],
          strokeColor:
            traceIndex === this.traceIndices[this.traceCursor] &&
            routeIndex === this.routeCursor
              ? "#ff7400"
              : start.layer === "bottom"
                ? "#376fc4"
                : "#777",
          strokeWidth: start.width,
        });
      }
    }
    return {
      coordinateSystem: "cartesian",
      title: "Power trace clearance repair",
      lines,
      points: [],
      circles: [],
      rects: [],
      texts: [],
    };
  }
}
