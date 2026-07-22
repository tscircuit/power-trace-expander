import type {
  SimpleRouteConnection,
  SimplifiedPcbTrace,
} from "@tscircuit/core";
import { BaseSolver } from "@tscircuit/solver-utils";
import type { GraphicsObject } from "graphics-debug";
import {
  approximateSegmentWithRects,
  clamp,
  distance,
  distancePointToSegment,
  WIDTH_EPSILON,
} from "./geometry";
import { ObstacleAwareGridRouteSolver } from "./ObstacleAwareGridRouteSolver";
import { SpatialObstacleIndex } from "./SpatialObstacleIndex";
import type {
  GridOffset,
  GridRouteOutput,
  IndexedObstacle,
  InflationCorridorSegment,
  LocalTraceInflationOutput,
  LocalTraceInflationProblem,
  WireRoutePoint,
} from "./types";

type InflationPhase =
  | "scan-corridor"
  | "select-blocker"
  | "try-grid-candidate"
  | "complete";

type BlockingTrace = {
  traceIndex: number;
  firstRouteIndex: number;
  lastRouteIndex: number;
};

const GRID_OFFSETS: GridOffset[] = [
  { x: 0, y: 0 },
  { x: 0.5, y: 0 },
  { x: 0, y: 0.5 },
  { x: 0.5, y: 0.5 },
];

const isWire = (
  point: SimplifiedPcbTrace["route"][number] | undefined,
): point is WireRoutePoint => point?.route_type === "wire";

/**
 * Moves a lower-width trace out of a local, nominal-width power corridor.
 * Endpoints outside the corridor remain fixed, so the displacement preserves
 * the trace's electrical topology and never moves a pad or via.
 */
export class LocalTraceInflationSolver extends BaseSolver {
  readonly inputProblem: LocalTraceInflationProblem;
  traces: SimplifiedPcbTrace[];
  readonly corridor: InflationCorridorSegment[];

  phase: InflationPhase = "scan-corridor";
  corridorCursor = 0;
  blockerCursor = 0;
  offsetCursor = 0;
  resolutionCursor = 0;
  attemptedGridCount = 0;

  private readonly blockerIndex: SpatialObstacleIndex;
  private readonly blockersByTrace = new Map<number, BlockingTrace>();
  private blockers: BlockingTrace[] = [];
  private currentBlocker: BlockingTrace | null = null;
  private currentRange: { startIndex: number; endIndex: number } | null = null;
  private currentTraceWidth = 0;
  private gridResolutions: number[] = [];
  private output: LocalTraceInflationOutput | null = null;

  declare activeSubSolver: ObstacleAwareGridRouteSolver | null;

  constructor(inputProblem: LocalTraceInflationProblem) {
    super();
    this.inputProblem = structuredClone(inputProblem);
    this.traces = structuredClone(inputProblem.traces);
    this.corridor = structuredClone(inputProblem.corridor);
    this.blockerIndex = new SpatialObstacleIndex(
      this.inputProblem.simpleRouteJson,
      this.traces,
      inputProblem.powerTraceIndex,
    );
    this.activeSubSolver = null;
    this.MAX_ITERATIONS = 25_000;
    this.stats = this.createStats();
  }

  override getSolverName() {
    return "LocalTraceInflationSolver";
  }

  override _step() {
    if (this.activeSubSolver) {
      this.stepGridSolver();
      this.stats = this.createStats();
      return;
    }

    switch (this.phase) {
      case "scan-corridor":
        this.scanNextCorridorSegment();
        break;
      case "select-blocker":
        this.selectNextBlocker();
        break;
      case "try-grid-candidate":
        this.startNextGridCandidate();
        break;
      case "complete":
        if (this.output) this.solved = true;
        else {
          this.failed = true;
          this.error = "No locally reroutable trace blocks the power corridor";
        }
        break;
    }
    this.stats = this.createStats();
  }

  private scanNextCorridorSegment() {
    const corridorSegment = this.corridor[this.corridorCursor];
    if (!corridorSegment) {
      this.blockers = [...this.blockersByTrace.values()].sort(
        (a, b) => a.traceIndex - b.traceIndex,
      );
      this.phase = "select-blocker";
      return;
    }

    const powerTrace = this.traces[this.inputProblem.powerTraceIndex];
    const collisions = this.blockerIndex.findCollisions({
      start: corridorSegment.start,
      end: corridorSegment.end,
      layer: corridorSegment.layer,
      width: corridorSegment.width,
      connectionNames: powerTrace
        ? this.getTraceConnectionNames(powerTrace)
        : [],
    });

    for (const item of collisions) this.recordBlockingTrace(item);
    this.corridorCursor++;
  }

  private recordBlockingTrace(item: IndexedObstacle) {
    if (
      item.kind !== "trace" ||
      item.traceIndex === undefined ||
      item.routeStartIndex === undefined ||
      item.routeEndIndex === undefined ||
      item.traceIndex === this.inputProblem.powerTraceIndex
    ) {
      return;
    }

    const trace = this.traces[item.traceIndex];
    if (!trace) return;
    const connection = this.findConnectionForTrace(trace);
    if (!connection) return;
    const traceWidth = this.resolveNominalTraceWidth(connection);
    if (traceWidth >= this.inputProblem.nominalPowerWidth - WIDTH_EPSILON) {
      return;
    }

    const existing = this.blockersByTrace.get(item.traceIndex);
    if (existing) {
      existing.firstRouteIndex = Math.min(
        existing.firstRouteIndex,
        item.routeStartIndex,
      );
      existing.lastRouteIndex = Math.max(
        existing.lastRouteIndex,
        item.routeEndIndex,
      );
      return;
    }
    this.blockersByTrace.set(item.traceIndex, {
      traceIndex: item.traceIndex,
      firstRouteIndex: item.routeStartIndex,
      lastRouteIndex: item.routeEndIndex,
    });
  }

  private selectNextBlocker() {
    this.currentBlocker = this.blockers[this.blockerCursor] ?? null;
    if (!this.currentBlocker) {
      this.phase = "complete";
      return;
    }

    const range = this.findStableAnchorRange(this.currentBlocker);
    if (!range) {
      this.blockerCursor++;
      return;
    }

    const trace = this.traces[this.currentBlocker.traceIndex]!;
    this.currentRange = range;
    this.currentTraceWidth = this.getRangeWidth(trace, range);
    this.gridResolutions = this.getGridResolutions(this.currentTraceWidth);
    this.resolutionCursor = 0;
    this.offsetCursor = 0;
    this.phase = "try-grid-candidate";
  }

  private findStableAnchorRange(blocker: BlockingTrace) {
    const trace = this.traces[blocker.traceIndex];
    if (!trace) return null;
    let startIndex = blocker.firstRouteIndex;
    let endIndex = blocker.lastRouteIndex;

    while (startIndex > 0) {
      const point = trace.route[startIndex];
      if (isWire(point) && this.pointClearsCorridor(point)) break;
      startIndex--;
    }
    while (endIndex < trace.route.length - 1) {
      const point = trace.route[endIndex];
      if (isWire(point) && this.pointClearsCorridor(point)) break;
      endIndex++;
    }

    const start = trace.route[startIndex];
    const end = trace.route[endIndex];
    if (
      !isWire(start) ||
      !isWire(end) ||
      start.layer !== end.layer ||
      !this.pointClearsCorridor(start) ||
      !this.pointClearsCorridor(end) ||
      startIndex >= endIndex
    ) {
      return null;
    }

    const range = { startIndex, endIndex };
    const routeLength = this.getRangeLength(trace, range);
    if (
      !Number.isFinite(routeLength) ||
      routeLength > (this.inputProblem.maxRerouteLength ?? 10) + WIDTH_EPSILON
    ) {
      return null;
    }
    return range;
  }

  private pointClearsCorridor(point: WireRoutePoint) {
    return this.corridor.every((segment) => {
      if (segment.layer !== point.layer) return true;
      const requiredDistance =
        segment.width / 2 + point.width / 2 + this.blockerIndex.clearance;
      return (
        distancePointToSegment(point, segment.start, segment.end) >=
        requiredDistance - WIDTH_EPSILON
      );
    });
  }

  private startNextGridCandidate() {
    if (!this.currentBlocker || !this.currentRange) {
      this.phase = "select-blocker";
      return;
    }
    if (this.resolutionCursor >= this.gridResolutions.length) {
      this.blockerCursor++;
      this.phase = "select-blocker";
      return;
    }
    if (this.offsetCursor >= GRID_OFFSETS.length) {
      this.resolutionCursor++;
      this.offsetCursor = 0;
      return;
    }

    const trace = this.traces[this.currentBlocker.traceIndex]!;
    const start = trace.route[this.currentRange.startIndex];
    const end = trace.route[this.currentRange.endIndex];
    if (!isWire(start) || !isWire(end)) {
      this.blockerCursor++;
      this.phase = "select-blocker";
      return;
    }

    const gridSize = this.gridResolutions[this.resolutionCursor]!;
    const normalizedOffset = GRID_OFFSETS[this.offsetCursor]!;
    const obstacleIndex = new SpatialObstacleIndex(
      this.inputProblem.simpleRouteJson,
      this.traces,
      this.currentBlocker.traceIndex,
      this.createInflatedCorridorItems(),
    );
    this.attemptedGridCount++;
    this.activeSubSolver = new ObstacleAwareGridRouteSolver({
      start,
      end,
      layer: start.layer,
      traceWidth: this.currentTraceWidth,
      gridSize,
      gridOffset: {
        x: normalizedOffset.x * gridSize,
        y: normalizedOffset.y * gridSize,
      },
      connectionNames: this.getTraceConnectionNames(trace),
      obstacleIndex,
      ignoreTraceIndex: this.currentBlocker.traceIndex,
      ignoreRouteRange: {
        start: this.currentRange.startIndex,
        end: this.currentRange.endIndex,
      },
      bounds: this.inputProblem.simpleRouteJson.bounds,
      searchPadding: clamp(this.inputProblem.nominalPowerWidth * 2.5, 1.5, 4),
    });
  }

  private stepGridSolver() {
    const solver = this.activeSubSolver!;
    solver.step();
    if (!solver.solved && !solver.failed) return;

    if (solver.solved) {
      const output = solver.getOutput();
      if (output) {
        this.applyGridRoute(output);
        this.activeSubSolver = null;
        this.phase = "complete";
        return;
      }
    }

    this.failedSubSolvers ??= [];
    this.failedSubSolvers.push(solver);
    this.activeSubSolver = null;
    this.offsetCursor++;
  }

  private applyGridRoute(output: GridRouteOutput) {
    const blocker = this.currentBlocker!;
    const range = this.currentRange!;
    const trace = this.traces[blocker.traceIndex]!;
    const originalStart = trace.route[range.startIndex] as WireRoutePoint;
    const originalEnd = trace.route[range.endIndex] as WireRoutePoint;
    const replacement: WireRoutePoint[] = output.points.map((point) => ({
      route_type: "wire",
      x: point.x,
      y: point.y,
      width: this.currentTraceWidth,
      layer: originalStart.layer,
    }));
    replacement[0]!.width = Math.max(
      replacement[0]!.width,
      originalStart.width,
    );
    replacement[replacement.length - 1]!.width = Math.max(
      replacement[replacement.length - 1]!.width,
      originalEnd.width,
    );
    trace.route.splice(
      range.startIndex,
      range.endIndex - range.startIndex + 1,
      ...replacement,
    );
    this.output = {
      traces: this.traces,
      pushedTraceIndex: blocker.traceIndex,
      replacedRange: range,
    };
  }

  private createInflatedCorridorItems() {
    return this.corridor.flatMap((segment) =>
      approximateSegmentWithRects({
        start: segment.start,
        end: segment.end,
        width: segment.width,
        base: {
          layers: [segment.layer],
          kind: "obstacle",
          connectionNames: [],
        },
      }),
    );
  }

  private getGridResolutions(traceWidth: number) {
    return [
      clamp(traceWidth * 1.5, 0.1, 0.3),
      clamp(traceWidth * 0.75, 0.08, 0.18),
    ].filter(
      (value, index, values) =>
        values.findIndex(
          (candidate) => Math.abs(candidate - value) < WIDTH_EPSILON,
        ) === index,
    );
  }

  private getRangeWidth(
    trace: SimplifiedPcbTrace,
    range: { startIndex: number; endIndex: number },
  ) {
    let width = this.inputProblem.simpleRouteJson.minTraceWidth;
    for (let index = range.startIndex; index <= range.endIndex; index++) {
      const point = trace.route[index];
      if (isWire(point)) width = Math.max(width, point.width);
    }
    return width;
  }

  private getRangeLength(
    trace: SimplifiedPcbTrace,
    range: { startIndex: number; endIndex: number },
  ) {
    let length = 0;
    for (let index = range.startIndex; index < range.endIndex; index++) {
      const start = trace.route[index];
      const end = trace.route[index + 1];
      if (!isWire(start) || !isWire(end) || start.layer !== end.layer) {
        return Number.POSITIVE_INFINITY;
      }
      length += distance(start, end);
    }
    return length;
  }

  private resolveNominalTraceWidth(connection: SimpleRouteConnection) {
    return Math.max(
      connection.nominalTraceWidth ??
        connection.width ??
        this.inputProblem.simpleRouteJson.nominalTraceWidth ??
        this.inputProblem.simpleRouteJson.minTraceWidth,
      this.inputProblem.simpleRouteJson.minTraceWidth,
    );
  }

  private findConnectionForTrace(trace: SimplifiedPcbTrace) {
    const names = this.getTraceConnectionNames(trace);
    return this.inputProblem.simpleRouteJson.connections.find((connection) =>
      [
        connection.name,
        connection.source_trace_id,
        connection.rootConnectionName,
        ...(connection.mergedConnectionNames ?? []),
      ]
        .filter((name): name is string => Boolean(name))
        .some((name) => names.includes(name)),
    );
  }

  private getTraceConnectionNames(trace: SimplifiedPcbTrace) {
    return [
      trace.connection_name,
      trace.source_trace_id,
      trace.rootConnectionName,
      ...(trace.mergedConnectionNames ?? []),
    ].filter((name): name is string => Boolean(name));
  }

  private createStats() {
    return {
      phase: this.phase,
      corridorSegment: this.corridorCursor,
      corridorSegmentCount: this.corridor.length,
      blockingTraceCount: this.blockersByTrace.size,
      blockerCursor: this.blockerCursor,
      pushedTraceIndex: this.currentBlocker?.traceIndex,
      anchorRange: this.currentRange,
      traceWidth: this.currentTraceWidth,
      gridSize: this.gridResolutions[this.resolutionCursor],
      gridOffsetVariant: this.offsetCursor,
      attemptedGridCount: this.attemptedGridCount,
    };
  }

  computeProgress() {
    if (this.phase === "scan-corridor") {
      return this.corridor.length === 0
        ? 0.25
        : (this.corridorCursor / this.corridor.length) * 0.25;
    }
    if (this.blockers.length === 0) return 0.5;
    return Math.min(0.99, 0.25 + this.blockerCursor / this.blockers.length);
  }

  override getOutput() {
    return this.output;
  }

  override getConstructorParams() {
    return [this.inputProblem];
  }

  override visualize(): GraphicsObject {
    const lines: NonNullable<GraphicsObject["lines"]> = [];
    for (let traceIndex = 0; traceIndex < this.traces.length; traceIndex++) {
      const trace = this.traces[traceIndex]!;
      for (let index = 0; index < trace.route.length - 1; index++) {
        const start = trace.route[index];
        const end = trace.route[index + 1];
        if (!isWire(start) || !isWire(end) || start.layer !== end.layer)
          continue;
        lines.push({
          points: [start, end],
          strokeColor:
            traceIndex === this.currentBlocker?.traceIndex ? "#1769d2" : "#777",
          strokeWidth: Math.max(start.width, end.width),
        });
      }
    }
    for (const segment of this.corridor) {
      lines.push({
        points: [segment.start, segment.end],
        strokeColor: "rgba(255, 128, 0, 0.55)",
        strokeWidth: segment.width,
      });
    }
    return {
      coordinateSystem: "cartesian",
      title: this.getSolverName(),
      lines,
      points: [],
      rects: [],
      circles: [],
      texts: [],
    };
  }
}
