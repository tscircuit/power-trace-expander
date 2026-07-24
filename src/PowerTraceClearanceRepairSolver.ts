import type { SimpleRouteJson, SimplifiedPcbTrace } from "@tscircuit/core";
import { BaseSolver } from "@tscircuit/solver-utils";
import type { GraphicsObject } from "graphics-debug";
import { ConnectionNameResolver } from "./ConnectionNameResolver";
import { WIDTH_EPSILON } from "./geometry";
import { SpatialObstacleIndex } from "./SpatialObstacleIndex";
import type { WireRoutePoint } from "./types";

export type PowerTraceClearanceRepairProblem = {
  simpleRouteJson: SimpleRouteJson;
  traces: SimplifiedPcbTrace[];
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
  unresolvedSegmentCount = 0;
  totalWidthReduction = 0;

  private readonly connectionNameResolver: ConnectionNameResolver;
  private readonly minimumTraceWidth: number;

  constructor(inputProblem: PowerTraceClearanceRepairProblem) {
    super();
    this.inputProblem = structuredClone(inputProblem);
    this.traces = structuredClone(inputProblem.traces);
    this.connectionNameResolver = new ConnectionNameResolver(
      inputProblem.simpleRouteJson,
      this.traces,
    );
    this.minimumTraceWidth = inputProblem.simpleRouteJson.minTraceWidth;
    this.obstacleIndex = this.createConservativeObstacleIndex();
    this.MAX_ITERATIONS = Math.max(
      1,
      this.traces.reduce(
        (count, trace) => count + Math.max(0, trace.route.length - 1),
        0,
      ) * 3,
    );
    this.stats = this.createStats();
  }

  override getSolverName() {
    return "PowerTraceClearanceRepairSolver";
  }

  override _step() {
    const trace = this.traces[this.traceCursor];
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

  private segmentHasForeignTraceCollision(routeIndex: number, width: number) {
    const trace = this.traces[this.traceCursor];
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
        ignoreTraceIndex: this.traceCursor,
        ignoreRouteRange: {
          start: routeIndex,
          end: routeIndex + 1,
        },
      })
      .some(
        (collision) =>
          collision.kind === "trace" &&
          collision.traceIndex !== undefined &&
          collision.traceIndex !== this.traceCursor,
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
      traceCount: this.traces.length,
      routeCursor: this.routeCursor,
      repairedSegmentCount: this.repairedSegmentCount,
      unresolvedSegmentCount: this.unresolvedSegmentCount,
      totalWidthReduction: this.totalWidthReduction,
      spatialIndexRectCount: this.obstacleIndex.items.length,
    };
  }

  computeProgress() {
    if (this.traces.length === 0) return 1;
    return Math.min(0.99, this.traceCursor / this.traces.length);
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
            traceIndex === this.traceCursor && routeIndex === this.routeCursor
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
