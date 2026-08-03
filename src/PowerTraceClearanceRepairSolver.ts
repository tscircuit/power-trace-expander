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

/**
 * Direction-independent final copper-clearance guard.
 *
 * Core can reverse a solver route while associating it with a source trace,
 * which changes which endpoint width is serialized onto a segment. This pass
 * therefore validates every segment at the larger of its endpoint widths and
 * necks only the colliding transition. It never changes route geometry.
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
    this.obstacleIndex = this.createConservativeObstacleIndex();
    const initialSegmentCount = this.traceIndices.reduce(
      (count, traceIndex) =>
        count + Math.max(0, this.traces[traceIndex]!.route.length - 1),
      0,
    );
    // A pad-boundary repair inserts two points and rewinds one segment. Leave
    // enough headroom to visit those new segments and both trace terminals.
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

    const currentWidth = Math.max(start.width, end.width);
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
    const previousEndWidth = end.width;
    start.width = Math.min(start.width, repairedWidth);
    end.width = Math.min(end.width, repairedWidth);
    const reduction =
      previousStartWidth - start.width + (previousEndWidth - end.width);
    if (reduction <= WIDTH_EPSILON) {
      this.unresolvedSegmentCount++;
      this.stats = this.createStats();
      return;
    }

    this.repairedSegmentCount++;
    this.totalWidthReduction += reduction;
    this.obstacleIndex = this.createConservativeObstacleIndex();
    // Recheck the segment before this one because the shared endpoint width
    // participates in both directions after core serializes the final route.
    this.routeCursor = Math.max(0, routeIndex - 1);
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
    let startLimit = this.obstacleIndex.getConnectedPadWidthLimitAtPoint(
      query,
      start,
    );
    let endLimit = this.obstacleIndex.getConnectedPadWidthLimitAtPoint(
      query,
      end,
    );
    if (routeIndex === 0) {
      startLimit = this.getSmallerLimit(
        startLimit,
        this.obstacleIndex.getConnectedPadEndpointWidthLimitAtPoint(
          query,
          start,
        ),
      );
    }
    if (routeIndex + 1 === trace.route.length - 1) {
      endLimit = this.getSmallerLimit(
        endLimit,
        this.obstacleIndex.getConnectedPadEndpointWidthLimitAtPoint(query, end),
      );
    }
    // A component pad can be narrower than the board's global minimum trace
    // width. Copper must still neck to the physical pad cross-section while it
    // is inside the pad; the minimum applies again immediately outside it.
    const effectiveStartLimit = startLimit;
    const effectiveEndLimit = endLimit;
    if (
      (effectiveStartLimit === null ||
        start.width <= effectiveStartLimit + WIDTH_EPSILON) &&
      (effectiveEndLimit === null ||
        end.width <= effectiveEndLimit + WIDTH_EPSILON)
    ) {
      return false;
    }

    const previousStartWidth = start.width;
    const previousEndWidth = end.width;
    if (effectiveStartLimit !== null) {
      start.width = Math.min(start.width, effectiveStartLimit);
    }
    if (effectiveEndLimit !== null) {
      end.width = Math.min(end.width, effectiveEndLimit);
    }

    if (effectiveStartLimit !== null && effectiveEndLimit === null) {
      this.insertPadBoundaryTransition(
        trace,
        routeIndex,
        query,
        "start",
        start.width,
        previousEndWidth,
      );
    } else if (effectiveStartLimit === null && effectiveEndLimit !== null) {
      this.insertPadBoundaryTransition(
        trace,
        routeIndex,
        query,
        "end",
        end.width,
        previousStartWidth,
      );
    } else if (effectiveStartLimit !== null && effectiveEndLimit !== null) {
      const startBoundary = this.obstacleIndex.getConnectedPadBoundaryPoint(
        query,
        "start",
      );
      const endBoundary = this.obstacleIndex.getConnectedPadBoundaryPoint(
        query,
        "end",
      );
      if (startBoundary && endBoundary) {
        this.insertPadBoundaryTransition(
          trace,
          routeIndex,
          query,
          "start",
          start.width,
          previousEndWidth,
        );
        this.insertPadBoundaryTransition(
          trace,
          routeIndex + 2,
          query,
          "end",
          end.width,
          previousStartWidth,
        );
      }
    }

    this.totalWidthReduction +=
      previousStartWidth - start.width + (previousEndWidth - end.width);
    this.repairedPadNeckSegmentCount++;
    this.obstacleIndex = this.createConservativeObstacleIndex();
    this.routeCursor = Math.max(0, routeIndex - 1);
    return true;
  }

  private getSmallerLimit(a: number | null, b: number | null): number | null {
    if (a === null) return b;
    if (b === null) return a;
    return Math.min(a, b);
  }

  private insertPadBoundaryTransition(
    trace: SimplifiedPcbTrace,
    routeIndex: number,
    query: CollisionQuery,
    insideEndpoint: "start" | "end",
    insideWidth: number,
    outsideWidth: number,
  ): void {
    const boundary = this.obstacleIndex.getConnectedPadBoundaryPoint(
      query,
      insideEndpoint,
    );
    if (!boundary) return;
    const inside = insideEndpoint === "start" ? query.start : query.end;
    const outside = insideEndpoint === "start" ? query.end : query.start;
    const length = Math.hypot(outside.x - inside.x, outside.y - inside.y);
    if (length <= 1e-9) return;
    const epsilon = Math.min(1e-6, length / 4);
    const direction = {
      x: (outside.x - inside.x) / length,
      y: (outside.y - inside.y) / length,
    };
    const insideBoundary: WireRoutePoint = {
      route_type: "wire",
      x: boundary.x - direction.x * epsilon,
      y: boundary.y - direction.y * epsilon,
      width: insideWidth,
      layer: query.layer,
    };
    const outsideBoundary: WireRoutePoint = {
      ...insideBoundary,
      x: boundary.x + direction.x * epsilon,
      y: boundary.y + direction.y * epsilon,
      width: outsideWidth,
    };
    const outsideRoutePoint =
      insideEndpoint === "start"
        ? trace.route[routeIndex + 1]
        : trace.route[routeIndex];
    const pointBeyondOutside =
      insideEndpoint === "start"
        ? trace.route[routeIndex + 2]
        : trace.route[routeIndex - 1];
    if (isWire(outsideRoutePoint) && pointBeyondOutside?.route_type === "via") {
      const nominalWidth = this.resolveNominalTraceWidth(trace);
      if (
        !this.obstacleIndex.collides({
          ...query,
          start: outsideRoutePoint,
          end: outsideBoundary,
          width: nominalWidth,
        })
      ) {
        outsideRoutePoint.width = Math.max(
          outsideRoutePoint.width,
          nominalWidth,
        );
        outsideBoundary.width = outsideRoutePoint.width;
      }
    }
    trace.route.splice(
      routeIndex + 1,
      0,
      ...(insideEndpoint === "start"
        ? [insideBoundary, outsideBoundary]
        : [outsideBoundary, insideBoundary]),
    );
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

  private createConservativeObstacleIndex() {
    const conservativeTraces = structuredClone(this.traces);
    for (const trace of conservativeTraces) {
      for (let index = 0; index < trace.route.length - 1; index++) {
        const start = trace.route[index];
        const end = trace.route[index + 1];
        if (!isWire(start) || !isWire(end) || start.layer !== end.layer) {
          continue;
        }
        start.width = Math.max(start.width, end.width);
      }
    }
    return new SpatialObstacleIndex(
      this.inputProblem.simpleRouteJson,
      conservativeTraces,
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
    if (this.traceIndices.length === 0) return 1;
    return Math.min(0.99, this.traceCursor / this.traceIndices.length);
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
          strokeWidth: Math.max(start.width, end.width),
        });
      }
    }
    return {
      coordinateSystem: "cartesian",
      title: "Power trace direction-independent clearance repair",
      lines,
      points: [],
      circles: [],
      rects: [],
      texts: [],
    };
  }
}
