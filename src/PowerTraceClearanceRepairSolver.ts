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

const MIN_PAD_BOUNDARY_SEGMENT_LENGTH = 1e-3;

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
    this.obstacleIndex = new SpatialObstacleIndex(
      this.inputProblem.simpleRouteJson,
      this.traces,
      undefined,
      [],
      this.connectionNameResolver,
    );
    this.obstacleIndex = this.createConservativeObstacleIndex();
    const initialSegmentCount = this.traceIndices.reduce(
      (count, traceIndex) =>
        count + Math.max(0, this.traces[traceIndex]!.route.length - 1),
      0,
    );
    // A pad-boundary repair inserts a transition point and rewinds one segment.
    // Leave enough headroom to visit those new segments and both trace terminals.
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

    const padQuery: CollisionQuery = {
      start,
      end,
      layer: start.layer,
      width: Math.max(start.width, end.width),
      connectionNames: this.getTraceConnectionNames(trace),
      ignoreTraceIndex: traceIndex,
      ignoreRouteRange: { start: routeIndex, end: routeIndex + 1 },
    };
    if (this.repairConnectedPadNeck(trace, routeIndex, padQuery)) {
      this.stats = this.createStats();
      return;
    }
    const padExitBoundaryAtEnd =
      this.getSegmentConnectedPadWidthLimitAtEndpoint(
        trace,
        routeIndex,
        padQuery,
        "start",
      ) !== null && this.isPadExitBoundaryEnd(trace, routeIndex, padQuery);
    const currentWidth = padExitBoundaryAtEnd
      ? start.width
      : Math.max(start.width, end.width);
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
    if (!padExitBoundaryAtEnd) {
      end.width = Math.min(end.width, repairedWidth);
    }
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
    // A component pad can be narrower than the board's global minimum trace
    // width. Copper must still neck to the physical pad cross-section while it
    // is inside the pad; the minimum applies again immediately outside it.
    const effectiveStartLimit = this.getSegmentConnectedPadWidthLimitAtEndpoint(
      trace,
      routeIndex,
      query,
      "start",
    );
    const effectiveEndLimit = this.getSegmentConnectedPadWidthLimitAtEndpoint(
      trace,
      routeIndex,
      query,
      "end",
    );
    if (effectiveStartLimit === null && effectiveEndLimit === null) {
      return false;
    }

    const previousStartWidth = start.width;
    const previousEndWidth = end.width;

    if (effectiveStartLimit !== null && effectiveEndLimit === null) {
      if (start.width <= effectiveStartLimit + WIDTH_EPSILON) {
        return false;
      }
      start.width = Math.min(start.width, effectiveStartLimit);
      this.insertPadBoundaryTransition(
        trace,
        routeIndex,
        query,
        "start",
        start.width,
        previousEndWidth,
      );
    } else if (effectiveStartLimit === null && effectiveEndLimit !== null) {
      const boundary = this.obstacleIndex.getConnectedPadBoundaryPoint(
        query,
        "end",
      );
      const distToInside = boundary
        ? Math.hypot(boundary.x - end.x, boundary.y - end.y)
        : 0;
      const isTerminalEnd = routeIndex + 1 === trace.route.length - 1;
      const relevantWidth =
        distToInside < MIN_PAD_BOUNDARY_SEGMENT_LENGTH && isTerminalEnd
          ? end.width
          : Math.max(start.width, end.width);
      if (relevantWidth <= effectiveEndLimit + WIDTH_EPSILON) {
        return false;
      }
      const insideWidth = Math.min(
        previousStartWidth,
        previousEndWidth,
        effectiveEndLimit,
      );
      end.width = insideWidth;
      this.insertPadBoundaryTransition(
        trace,
        routeIndex,
        query,
        "end",
        insideWidth,
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
        const outsideWidth = previousStartWidth;
        const startNeedsRepair =
          previousStartWidth > effectiveStartLimit + WIDTH_EPSILON;
        const endNeedsRepair =
          Math.max(outsideWidth, previousEndWidth) >
          effectiveEndLimit + WIDTH_EPSILON;
        if (!startNeedsRepair && !endNeedsRepair) {
          return false;
        }
        let insertedAtStart = 0;
        if (startNeedsRepair) {
          start.width = Math.min(start.width, effectiveStartLimit);
          insertedAtStart = this.insertPadBoundaryTransition(
            trace,
            routeIndex,
            query,
            "start",
            start.width,
            outsideWidth,
          );
        }
        if (endNeedsRepair) {
          const insideEndWidth = Math.min(
            outsideWidth,
            previousEndWidth,
            effectiveEndLimit,
          );
          end.width = insideEndWidth;
          this.insertPadBoundaryTransition(
            trace,
            routeIndex + insertedAtStart,
            query,
            "end",
            insideEndWidth,
            outsideWidth,
          );
        }
      } else {
        const clampEnd = !this.isPadExitBoundaryEnd(trace, routeIndex, query);
        const startNeedsRepair =
          start.width > effectiveStartLimit + WIDTH_EPSILON;
        const endNeedsRepair =
          clampEnd && end.width > effectiveEndLimit + WIDTH_EPSILON;
        if (!startNeedsRepair && !endNeedsRepair) {
          return false;
        }
        if (startNeedsRepair) {
          start.width = Math.min(start.width, effectiveStartLimit);
        }
        if (endNeedsRepair) {
          end.width = Math.min(end.width, effectiveEndLimit);
        }
      }
    }

    this.totalWidthReduction +=
      Math.max(0, previousStartWidth - start.width) +
      Math.max(0, previousEndWidth - end.width);
    this.repairedPadNeckSegmentCount++;
    this.obstacleIndex = this.createConservativeObstacleIndex();
    this.routeCursor = Math.max(0, routeIndex - 1);
    return true;
  }

  private getSegmentConnectedPadWidthLimitAtEndpoint(
    trace: SimplifiedPcbTrace,
    routeIndex: number,
    query: CollisionQuery,
    endpoint: "start" | "end",
  ): number | null {
    const start = trace.route[routeIndex];
    const end = trace.route[routeIndex + 1];
    if (!isWire(start) || !isWire(end)) return null;
    const point = endpoint === "start" ? start : end;
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    if (length <= 1e-9) {
      return this.obstacleIndex.getConnectedPadWidthLimitAtPoint(query, point);
    }
    const probeFraction = Math.min(0.25, 1e-6 / length);
    const probe =
      endpoint === "start"
        ? {
            x: start.x + (end.x - start.x) * probeFraction,
            y: start.y + (end.y - start.y) * probeFraction,
          }
        : {
            x: end.x - (end.x - start.x) * probeFraction,
            y: end.y - (end.y - start.y) * probeFraction,
          };
    const pointLimit = this.obstacleIndex.getConnectedPadWidthLimitAtPoint(
      query,
      point,
    );
    const probeLimit = this.obstacleIndex.getConnectedPadWidthLimitAtPoint(
      query,
      probe,
    );
    if (pointLimit === null || probeLimit === null) {
      return null;
    }
    let limit = Math.min(pointLimit, probeLimit);
    const isTerminalEndpoint =
      (endpoint === "start" && routeIndex === 0) ||
      (endpoint === "end" && routeIndex + 1 === trace.route.length - 1);
    if (isTerminalEndpoint) {
      limit =
        this.getSmallerLimit(
          limit,
          this.obstacleIndex.getConnectedPadEndpointWidthLimitAtPoint(
            query,
            point,
          ),
        ) ?? limit;
    }
    return limit;
  }

  private isPadExitBoundaryEnd(
    trace: SimplifiedPcbTrace,
    routeIndex: number,
    query: CollisionQuery,
  ): boolean {
    const end = trace.route[routeIndex + 1];
    const next = trace.route[routeIndex + 2];
    if (!isWire(end) || !isWire(next) || end.layer !== next.layer) {
      return false;
    }
    const nextQuery: CollisionQuery = {
      ...query,
      start: end,
      end: next,
      ignoreRouteRange: { start: routeIndex + 1, end: routeIndex + 2 },
    };
    return (
      this.getSegmentConnectedPadWidthLimitAtEndpoint(
        trace,
        routeIndex + 1,
        nextQuery,
        "start",
      ) === null
    );
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
  ): number {
    const boundary = this.obstacleIndex.getConnectedPadBoundaryPoint(
      query,
      insideEndpoint,
    );
    if (!boundary) return 0;
    const inside = insideEndpoint === "start" ? query.start : query.end;
    const outside = insideEndpoint === "start" ? query.end : query.start;
    const length = Math.hypot(outside.x - inside.x, outside.y - inside.y);
    if (length <= 1e-9) return 0;

    let resolvedOutsideWidth = outsideWidth;
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
          end: boundary,
          width: nominalWidth,
        })
      ) {
        outsideRoutePoint.width = Math.max(
          outsideRoutePoint.width,
          nominalWidth,
        );
        resolvedOutsideWidth = outsideRoutePoint.width;
      }
    }

    const insideRouteIndex =
      insideEndpoint === "start" ? routeIndex : routeIndex + 1;
    const outsideRouteIndex =
      insideEndpoint === "start" ? routeIndex + 1 : routeIndex;
    const insideRoutePoint = trace.route[insideRouteIndex];
    const distToInside = Math.hypot(
      boundary.x - inside.x,
      boundary.y - inside.y,
    );
    const distToOutside = Math.hypot(
      boundary.x - outside.x,
      boundary.y - outside.y,
    );

    if (distToInside < MIN_PAD_BOUNDARY_SEGMENT_LENGTH) {
      const isInteriorInsideVertex =
        insideEndpoint === "start"
          ? insideRouteIndex > 0
          : insideRouteIndex < trace.route.length - 1;
      if (isWire(insideRoutePoint) && isInteriorInsideVertex) {
        insideRoutePoint.x = boundary.x;
        insideRoutePoint.y = boundary.y;
        insideRoutePoint.width =
          insideEndpoint === "start" ? resolvedOutsideWidth : insideWidth;
      }
      return 0;
    }

    if (distToOutside < MIN_PAD_BOUNDARY_SEGMENT_LENGTH) {
      const isInteriorOutsideVertex =
        insideEndpoint === "start"
          ? outsideRouteIndex < trace.route.length - 1
          : outsideRouteIndex > 0;
      if (isWire(outsideRoutePoint) && isInteriorOutsideVertex) {
        outsideRoutePoint.x = boundary.x;
        outsideRoutePoint.y = boundary.y;
      }
      if (insideEndpoint === "end" && isWire(outsideRoutePoint)) {
        outsideRoutePoint.width = insideWidth;
      }
      return 0;
    }

    const boundaryPoint: WireRoutePoint = {
      route_type: "wire",
      x: boundary.x,
      y: boundary.y,
      width: insideEndpoint === "start" ? resolvedOutsideWidth : insideWidth,
      layer: query.layer,
    };
    trace.route.splice(routeIndex + 1, 0, boundaryPoint);
    return 1;
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
    for (
      let traceIndex = 0;
      traceIndex < conservativeTraces.length;
      traceIndex++
    ) {
      const trace = conservativeTraces[traceIndex]!;
      const connectionNames = this.getTraceConnectionNames(trace);
      for (let index = 0; index < trace.route.length - 1; index++) {
        const start = trace.route[index];
        const end = trace.route[index + 1];
        if (!isWire(start) || !isWire(end) || start.layer !== end.layer) {
          continue;
        }
        if (start.width < end.width && this.obstacleIndex) {
          const query: CollisionQuery = {
            start,
            end,
            layer: start.layer,
            width: end.width,
            connectionNames,
            ignoreTraceIndex: traceIndex,
            ignoreRouteRange: { start: index, end: index + 1 },
          };
          if (
            this.getSegmentConnectedPadWidthLimitAtEndpoint(
              trace,
              index,
              query,
              "start",
            ) !== null &&
            this.isPadExitBoundaryEnd(trace, index, query)
          ) {
            continue;
          }
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
