import type {
  SimpleRouteConnection,
  SimplifiedPcbTrace,
} from "@tscircuit/core";
import { BaseSolver } from "@tscircuit/solver-utils";
import type { GraphicsObject } from "graphics-debug";
import { ConnectionNameResolver } from "./ConnectionNameResolver";
import {
  clamp,
  distance,
  splitUnderWidthWireSegments,
  WIDTH_EPSILON,
} from "./geometry";
import { LocalTraceInflationSolver } from "./LocalTraceInflationSolver";
import { ObstacleAwareGridRouteSolver } from "./ObstacleAwareGridRouteSolver";
import { SpatialObstacleIndex } from "./SpatialObstacleIndex";
import type {
  GridOffset,
  GridRouteOutput,
  InflationCorridorSegment,
  PowerTraceExpanderInput,
  PowerTraceExpanderOutput,
  WireRoutePoint,
} from "./types";

type SolverPhase =
  | "scan-trace"
  | "evaluate-segment"
  | "try-trace-inflation"
  | "try-grid-candidate"
  | "complete";

const GRID_OFFSETS: GridOffset[] = [
  { x: 0, y: 0 },
  { x: 0.5, y: 0 },
  { x: 0, y: 0.5 },
  { x: 0.5, y: 0.5 },
];

const uniqueDescending = (values: number[]) =>
  [...new Set(values.map((value) => Number(value.toFixed(6))))].sort(
    (a, b) => b - a,
  );

const isWire = (
  point: SimplifiedPcbTrace["route"][number] | undefined,
): point is WireRoutePoint => point?.route_type === "wire";

export class PowerTraceExpanderSolver extends BaseSolver {
  readonly inputProblem: PowerTraceExpanderInput;
  traces: SimplifiedPcbTrace[];
  obstacleIndex: SpatialObstacleIndex;
  private readonly connectionNameResolver: ConnectionNameResolver;
  private readonly traceOrder: number[];
  private traceOrderCursor = -1;
  private readonly maxPassCount = 4;
  private previousWidthDeficit = 0;
  passIndex = 0;
  completedPassCount = 0;
  lastNormalizedWidthDeficitGain = 0;
  readonly normalizedWidthDeficitGainByPass: number[] = [];
  plateauReached = false;

  phase: SolverPhase = "scan-trace";
  traceIndex = -1;
  routeSegmentIndex = 0;
  nominalTraceWidth = 0;
  currentIntervals: Array<{ startIndex: number; endIndex: number }> = [];
  intervalCursor = 0;
  candidateWidths: number[] = [];
  widthCursor = 0;
  gridResolutions: number[] = [];
  resolutionCursor = 0;
  offsetCursor = 0;

  keptTraceCount = 0;
  recreatedTraceCount = 0;
  expandedSegmentCount = 0;
  intermediateExpandedSegmentCount = 0;
  pathWidthUpgradeCount = 0;
  inPlaceWidthProbeCount = 0;
  reroutedSegmentCount = 0;
  unresolvedSegmentCount = 0;
  attemptedGridCount = 0;
  attemptedInflationCount = 0;
  pushedTraceCount = 0;
  elasticPushedTraceCount = 0;

  private readonly inflationAttemptsBySegment = new Map<string, number>();
  private activeInflationKey: string | null = null;
  private activeInflationWidth: number | null = null;

  declare activeSubSolver:
    | ObstacleAwareGridRouteSolver
    | LocalTraceInflationSolver
    | null;

  constructor(inputProblem: PowerTraceExpanderInput) {
    super();
    this.inputProblem = structuredClone(inputProblem);
    this.traces = structuredClone(inputProblem.traces ?? []);
    this.connectionNameResolver = new ConnectionNameResolver(
      this.inputProblem,
      this.traces,
    );
    this.traceOrder = this.traces.map((_, traceIndex) => traceIndex);
    this.previousWidthDeficit = this.calculateWidthDeficit().deficit;
    this.obstacleIndex = new SpatialObstacleIndex(
      this.inputProblem,
      this.traces,
      this.traceIndex >= 0 ? this.traceIndex : undefined,
      [],
      this.connectionNameResolver,
    );
    this.activeSubSolver = null;
    this.MAX_ITERATIONS = 8_000_000;
    this.stats = this.createStats();
  }

  override getSolverName() {
    return "PowerTraceExpanderSolver";
  }

  override _step() {
    if (this.activeSubSolver) {
      this.stepActiveGridSolver();
      this.stats = this.createStats();
      return;
    }

    switch (this.phase) {
      case "scan-trace":
        this.scanNextTrace();
        break;
      case "evaluate-segment":
        this.evaluateNextSegment();
        break;
      case "try-trace-inflation":
        // The active inflation solver is stepped before the phase switch.
        break;
      case "try-grid-candidate":
        this.startNextGridCandidate();
        break;
      case "complete":
        this.solved = true;
        break;
    }
    this.stats = this.createStats();
  }

  private scanNextTrace() {
    this.traceOrderCursor++;
    this.routeSegmentIndex = 0;
    if (this.traceOrderCursor >= this.traceOrder.length) {
      this.finishOrStartNextPass();
      return;
    }
    this.traceIndex = this.traceOrder[this.traceOrderCursor]!;

    const trace = this.traces[this.traceIndex]!;
    if (!this.findConnectionForTrace(trace)) {
      // Preserved child-subcircuit traces are supplied as fixed routing
      // geometry but have no connection in the current board SRJ. Re-emit them
      // byte-for-byte and use them only as obstacles for board-level traces.
      this.keptTraceCount++;
      return;
    }
    this.nominalTraceWidth = this.resolveNominalTraceWidth(trace);
    if (this.traceMeetsNominalWidth(trace, this.nominalTraceWidth)) {
      this.keptTraceCount++;
      return;
    }

    // Flatbush is immutable, so rebuild once per trace that will actually be
    // mutated. Fixed and already-conforming traces need no private index.
    this.rebuildObstacleIndex();

    trace.route = splitUnderWidthWireSegments(
      trace.route,
      this.nominalTraceWidth,
    ) as SimplifiedPcbTrace["route"];
    this.recreatedTraceCount++;
    this.phase = "evaluate-segment";
  }

  private finishOrStartNextPass() {
    const { deficit, nominalArea } = this.calculateWidthDeficit();
    const deficitGain = this.previousWidthDeficit - deficit;
    this.lastNormalizedWidthDeficitGain =
      nominalArea <= WIDTH_EPSILON ? 0 : deficitGain / nominalArea;
    this.normalizedWidthDeficitGainByPass.push(
      this.lastNormalizedWidthDeficitGain,
    );
    this.plateauReached = this.lastNormalizedWidthDeficitGain < 0.001;
    this.completedPassCount = this.passIndex + 1;

    // A sub-0.1% copper-area gain is the practical plateau. This keeps the
    // production fixture to three passes while still allowing one follow-up
    // pass to exploit geometry displaced during the initial solve.
    if (
      this.passIndex + 1 < this.maxPassCount &&
      this.lastNormalizedWidthDeficitGain >= 0.001
    ) {
      this.previousWidthDeficit = deficit;
      this.passIndex++;
      this.traceOrderCursor = -1;
      this.traceIndex = -1;
      this.routeSegmentIndex = 0;
      this.inflationAttemptsBySegment.clear();
      this.phase = "scan-trace";
      return;
    }

    this.traceIndex = this.traces.length;
    this.phase = "complete";
  }

  private calculateWidthDeficit() {
    let deficit = 0;
    let nominalArea = 0;
    for (const trace of this.traces) {
      if (!this.findConnectionForTrace(trace)) continue;
      const nominalWidth = this.resolveNominalTraceWidth(trace);
      for (let index = 0; index < trace.route.length - 1; index++) {
        const start = trace.route[index];
        const end = trace.route[index + 1];
        if (!isWire(start) || !isWire(end) || start.layer !== end.layer)
          continue;
        const segmentLength = distance(start, end);
        // Circuit JSON assigns a wire segment the width of its first point.
        const segmentWidth = start.width;
        nominalArea += segmentLength * nominalWidth;
        deficit += segmentLength * Math.max(0, nominalWidth - segmentWidth);
      }
    }
    return { deficit, nominalArea };
  }

  private evaluateNextSegment() {
    const trace = this.traces[this.traceIndex];
    if (!trace) {
      this.phase = "scan-trace";
      return;
    }

    const segmentIndex = this.findNextUnderWidthSegment(
      trace,
      this.routeSegmentIndex,
      this.nominalTraceWidth,
    );
    if (segmentIndex === -1) {
      this.phase = "scan-trace";
      return;
    }
    this.routeSegmentIndex = segmentIndex;
    const start = trace.route[segmentIndex]!;
    const end = trace.route[segmentIndex + 1]!;
    if (!isWire(start) || !isWire(end)) {
      this.routeSegmentIndex++;
      return;
    }

    const connectionNames = this.getTraceConnectionNames(trace);
    const currentWidth = Math.min(start.width, end.width);
    const bestInPlaceWidth = this.findMaximumSafeInPlaceWidth(
      trace,
      segmentIndex,
      connectionNames,
    );

    if (bestInPlaceWidth > currentWidth + WIDTH_EPSILON) {
      start.width = Math.max(start.width, bestInPlaceWidth);
      end.width = Math.max(end.width, bestInPlaceWidth);
      if (bestInPlaceWidth >= this.nominalTraceWidth - WIDTH_EPSILON) {
        this.expandedSegmentCount++;
        this.routeSegmentIndex++;
        return;
      }
      this.intermediateExpandedSegmentCount++;
    }

    if (this.startTraceInflation(trace, segmentIndex)) return;

    this.currentIntervals = this.getExponentialIntervalCandidates(
      trace,
      segmentIndex,
      this.nominalTraceWidth,
    );
    this.intervalCursor = 0;
    this.candidateWidths = this.getCandidateWidths(this.nominalTraceWidth);
    this.widthCursor = 0;
    this.gridResolutions = [];
    this.resolutionCursor = 0;
    this.offsetCursor = 0;
    if (this.currentIntervals.length === 0) {
      this.unresolvedSegmentCount++;
      this.routeSegmentIndex++;
      return;
    }
    this.phase = "try-grid-candidate";
  }

  private startNextGridCandidate() {
    const trace = this.traces[this.traceIndex];
    if (!trace) {
      this.phase = "scan-trace";
      return;
    }
    if (this.widthCursor >= this.candidateWidths.length) {
      this.unresolvedSegmentCount++;
      this.routeSegmentIndex++;
      this.phase = "evaluate-segment";
      return;
    }
    if (this.intervalCursor >= this.currentIntervals.length) {
      this.widthCursor++;
      this.intervalCursor = 0;
      this.gridResolutions = [];
      this.resolutionCursor = 0;
      this.offsetCursor = 0;
      return;
    }
    const candidateWidth = this.candidateWidths[this.widthCursor]!;
    const blockedStart = trace.route[this.routeSegmentIndex];
    const blockedEnd = trace.route[this.routeSegmentIndex + 1];
    if (
      isWire(blockedStart) &&
      isWire(blockedEnd) &&
      candidateWidth <=
        Math.min(blockedStart.width, blockedEnd.width) + WIDTH_EPSILON
    ) {
      this.widthCursor = this.candidateWidths.length;
      return;
    }
    if (this.gridResolutions.length === 0) {
      this.gridResolutions = this.getGridResolutions(candidateWidth);
    }
    if (this.resolutionCursor >= this.gridResolutions.length) {
      this.intervalCursor++;
      this.resolutionCursor = 0;
      this.offsetCursor = 0;
      return;
    }
    if (this.offsetCursor >= GRID_OFFSETS.length) {
      this.resolutionCursor++;
      this.offsetCursor = 0;
      return;
    }

    const interval = this.currentIntervals[this.intervalCursor]!;
    const start = trace.route[interval.startIndex]!;
    const end = trace.route[interval.endIndex]!;
    if (!isWire(start) || !isWire(end) || start.layer !== end.layer) {
      this.intervalCursor++;
      this.resolutionCursor = 0;
      this.offsetCursor = 0;
      return;
    }
    if (
      this.endpointCollides(trace, interval, start, candidateWidth) ||
      this.endpointCollides(trace, interval, end, candidateWidth)
    ) {
      this.intervalCursor++;
      this.resolutionCursor = 0;
      this.offsetCursor = 0;
      return;
    }

    const gridSize = this.gridResolutions[this.resolutionCursor]!;
    const normalizedOffset = GRID_OFFSETS[this.offsetCursor]!;
    const gridOffset = {
      x: normalizedOffset.x * gridSize,
      y: normalizedOffset.y * gridSize,
    };
    this.attemptedGridCount++;
    this.activeSubSolver = new ObstacleAwareGridRouteSolver({
      start,
      end,
      layer: start.layer,
      traceWidth: candidateWidth,
      gridSize,
      gridOffset,
      connectionNames: this.getTraceConnectionNames(trace),
      obstacleIndex: this.obstacleIndex,
      ignoreTraceIndex: this.traceIndex,
      ignoreRouteRange: {
        start: Math.max(0, interval.startIndex - 1),
        end: Math.min(trace.route.length - 1, interval.endIndex + 1),
      },
      bounds: this.inputProblem.bounds,
      searchPadding: Math.min(
        5,
        Math.max(1.5, distance(start, end) / 2, candidateWidth * 3),
      ),
    });
  }

  private endpointCollides(
    trace: SimplifiedPcbTrace,
    interval: { startIndex: number; endIndex: number },
    point: WireRoutePoint,
    width: number,
  ) {
    return this.obstacleIndex.collides({
      start: point,
      end: point,
      layer: point.layer,
      width,
      connectionNames: this.getTraceConnectionNames(trace),
      ignoreTraceIndex: this.traceIndex,
      ignoreRouteRange: {
        start: Math.max(0, interval.startIndex - 1),
        end: Math.min(trace.route.length - 1, interval.endIndex + 1),
      },
    });
  }

  private stepActiveGridSolver() {
    if (this.activeSubSolver instanceof LocalTraceInflationSolver) {
      this.stepActiveInflationSolver();
      return;
    }
    const solver = this.activeSubSolver!;
    solver.step();
    if (!solver.solved && !solver.failed) return;

    if (solver.solved) {
      const output = solver.getOutput();
      if (
        output &&
        !this.gridRouteReplacementCollides(output) &&
        !this.gridRouteBoundaryCollides(output)
      ) {
        this.applyGridRoute(this.maximizeGridRouteWidth(output));
        this.activeSubSolver = null;
        return;
      }
    }

    this.failedSubSolvers ??= [];
    this.failedSubSolvers.push(solver);
    this.activeSubSolver = null;
    this.offsetCursor++;
  }

  private startTraceInflation(trace: SimplifiedPcbTrace, segmentIndex: number) {
    const segmentStart = trace.route[segmentIndex];
    const segmentEnd = trace.route[segmentIndex + 1];
    if (!isWire(segmentStart) || !isWire(segmentEnd)) return false;
    const currentWidth = Math.min(segmentStart.width, segmentEnd.width);
    const targetWidth = this.findBestPushableInflationWidth(
      trace,
      segmentIndex,
      currentWidth,
    );
    if (!targetWidth) return false;
    const corridor = this.getLocalInflationCorridor(
      trace,
      segmentIndex,
      targetWidth,
    );
    if (corridor.length === 0) return false;
    const key = [
      this.traceIndex,
      segmentStart.x,
      segmentStart.y,
      segmentEnd.x,
      segmentEnd.y,
    ].join(":");
    const attemptCount = this.inflationAttemptsBySegment.get(key) ?? 0;
    if (attemptCount >= 2) return false;

    this.inflationAttemptsBySegment.set(key, attemptCount + 1);
    this.activeInflationKey = key;
    this.activeInflationWidth = targetWidth;
    this.attemptedInflationCount++;
    this.activeSubSolver = new LocalTraceInflationSolver(
      {
        simpleRouteJson: this.inputProblem,
        traces: this.traces,
        powerTraceIndex: this.traceIndex,
        nominalPowerWidth: targetWidth,
        corridor,
        maxRerouteLength: 10,
      },
      this.connectionNameResolver,
    );
    this.phase = "try-trace-inflation";
    return true;
  }

  private hasOnlyPushableTraceBlockers(
    trace: SimplifiedPcbTrace,
    segmentIndex: number,
    targetWidth: number,
  ) {
    const firstAffectedSegment = Math.max(0, segmentIndex - 1);
    const lastAffectedSegment = Math.min(
      trace.route.length - 2,
      segmentIndex + 1,
    );
    const pushableTraceIndices = new Set<number>();

    for (
      let affectedIndex = firstAffectedSegment;
      affectedIndex <= lastAffectedSegment;
      affectedIndex++
    ) {
      const start = trace.route[affectedIndex];
      const end = trace.route[affectedIndex + 1];
      if (!isWire(start) || !isWire(end) || start.layer !== end.layer) continue;
      const query = {
        start,
        end,
        layer: start.layer,
        width: targetWidth,
        connectionNames: this.getTraceConnectionNames(trace),
        ignoreTraceIndex: this.traceIndex,
        ignoreRouteRange: {
          start: firstAffectedSegment,
          end: lastAffectedSegment + 1,
        },
      };
      const collisions = this.obstacleIndex.findCollisions(query);
      if (collisions.length === 0 && this.obstacleIndex.collides(query)) {
        return false;
      }
      for (const collision of collisions) {
        if (collision.kind !== "trace" || collision.traceIndex === undefined) {
          return false;
        }
        const blockingTrace = this.traces[collision.traceIndex];
        if (!blockingTrace) return false;
        const connection = this.findConnectionForTrace(blockingTrace);
        if (
          !connection ||
          (connection.nominalTraceWidth ??
            connection.width ??
            this.inputProblem.nominalTraceWidth ??
            this.inputProblem.minTraceWidth) >=
            targetWidth - WIDTH_EPSILON
        ) {
          return false;
        }
        pushableTraceIndices.add(collision.traceIndex);
      }
    }

    // Pushing a small local bundle remains predictable; larger bundles should
    // be handled by the board-level router rather than a post-route repair.
    return pushableTraceIndices.size > 0 && pushableTraceIndices.size <= 2;
  }

  private findBestPushableInflationWidth(
    trace: SimplifiedPcbTrace,
    segmentIndex: number,
    currentWidth: number,
  ) {
    const quantum = this.nominalTraceWidth >= 0.5 ? 0.05 : 0.0125;
    for (
      let targetWidth = this.nominalTraceWidth;
      targetWidth > currentWidth + WIDTH_EPSILON;
      targetWidth -= quantum
    ) {
      const quantizedTarget = Number(targetWidth.toFixed(6));
      if (
        this.hasOnlyPushableTraceBlockers(trace, segmentIndex, quantizedTarget)
      ) {
        return quantizedTarget;
      }
    }
    return null;
  }

  private stepActiveInflationSolver() {
    const solver = this.activeSubSolver as LocalTraceInflationSolver;
    solver.step();
    if (!solver.solved && !solver.failed) return;

    if (solver.solved) {
      const output = solver.getOutput();
      if (output) {
        this.traces = output.traces;
        this.pushedTraceCount++;
        if (output.strategy === "elastic") this.elasticPushedTraceCount++;
        this.activeSubSolver = null;
        this.activeInflationKey = null;
        this.activeInflationWidth = null;
        this.rebuildObstacleIndex();
        this.phase = "evaluate-segment";
        return;
      }
    }

    this.failedSubSolvers ??= [];
    this.failedSubSolvers.push(solver);
    if (this.activeInflationKey) {
      this.inflationAttemptsBySegment.set(this.activeInflationKey, 2);
    }
    this.activeInflationKey = null;
    this.activeInflationWidth = null;
    this.activeSubSolver = null;
    this.phase = "evaluate-segment";
  }

  private getLocalInflationCorridor(
    trace: SimplifiedPcbTrace,
    segmentIndex: number,
    targetWidth: number,
  ): InflationCorridorSegment[] {
    const firstPoint = trace.route[segmentIndex];
    const secondPoint = trace.route[segmentIndex + 1];
    if (
      !isWire(firstPoint) ||
      !isWire(secondPoint) ||
      firstPoint.layer !== secondPoint.layer
    ) {
      return [];
    }

    const maximumCorridorLength = clamp(targetWidth * 4, 2, 4);
    const halfCorridorLength = maximumCorridorLength / 2;
    let startIndex = segmentIndex;
    let distanceBefore = 0;
    while (startIndex > 0) {
      const start = trace.route[startIndex - 1];
      const end = trace.route[startIndex];
      if (!isWire(start) || !isWire(end) || start.layer !== end.layer) break;
      const segmentLength = distance(start, end);
      if (distanceBefore + segmentLength > halfCorridorLength + WIDTH_EPSILON)
        break;
      distanceBefore += segmentLength;
      startIndex--;
    }

    let endIndex = segmentIndex + 1;
    let distanceAfter = 0;
    while (endIndex < trace.route.length - 1) {
      const start = trace.route[endIndex];
      const end = trace.route[endIndex + 1];
      if (!isWire(start) || !isWire(end) || start.layer !== end.layer) break;
      const segmentLength = distance(start, end);
      if (distanceAfter + segmentLength > halfCorridorLength + WIDTH_EPSILON)
        break;
      distanceAfter += segmentLength;
      endIndex++;
    }

    // Spend unused room from either half of the 10 mm window on the other
    // side. This keeps the affected area small while still covering a full
    // corridor when the blocked segment is close to one endpoint.
    let remainingDistance =
      maximumCorridorLength - distanceBefore - distanceAfter;
    while (remainingDistance > WIDTH_EPSILON && startIndex > 0) {
      const start = trace.route[startIndex - 1];
      const end = trace.route[startIndex];
      if (!isWire(start) || !isWire(end) || start.layer !== end.layer) break;
      const segmentLength = distance(start, end);
      if (segmentLength > remainingDistance + WIDTH_EPSILON) break;
      remainingDistance -= segmentLength;
      startIndex--;
    }
    while (
      remainingDistance > WIDTH_EPSILON &&
      endIndex < trace.route.length - 1
    ) {
      const start = trace.route[endIndex];
      const end = trace.route[endIndex + 1];
      if (!isWire(start) || !isWire(end) || start.layer !== end.layer) break;
      const segmentLength = distance(start, end);
      if (segmentLength > remainingDistance + WIDTH_EPSILON) break;
      remainingDistance -= segmentLength;
      endIndex++;
    }

    const corridor: InflationCorridorSegment[] = [];
    for (let index = startIndex; index < endIndex; index++) {
      const start = trace.route[index];
      const end = trace.route[index + 1];
      if (!isWire(start) || !isWire(end) || start.layer !== end.layer) continue;
      corridor.push({
        start,
        end,
        layer: start.layer,
        width: targetWidth,
      });
    }
    return corridor;
  }

  private applyGridRoute(output: GridRouteOutput) {
    const trace = this.traces[this.traceIndex]!;
    const interval = this.currentIntervals[this.intervalCursor]!;
    const startPoint = trace.route[interval.startIndex] as WireRoutePoint;
    const endPoint = trace.route[interval.endIndex] as WireRoutePoint;
    const replacement: WireRoutePoint[] = output.points.map((point) => ({
      route_type: "wire",
      x: point.x,
      y: point.y,
      width: output.traceWidth,
      layer: startPoint.layer,
    }));
    replacement[0]!.width = Math.max(startPoint.width, output.traceWidth);
    replacement[replacement.length - 1]!.width = Math.max(
      endPoint.width,
      output.traceWidth,
    );
    trace.route.splice(
      interval.startIndex,
      interval.endIndex - interval.startIndex + 1,
      ...replacement,
    );
    this.reroutedSegmentCount++;
    this.routeSegmentIndex = interval.startIndex + replacement.length - 1;
    this.currentIntervals = [];
    this.phase = "evaluate-segment";
  }

  private gridRouteReplacementCollides(output: GridRouteOutput) {
    const trace = this.traces[this.traceIndex]!;
    const interval = this.currentIntervals[this.intervalCursor]!;
    const originalStart = trace.route[interval.startIndex] as WireRoutePoint;
    const originalEnd = trace.route[interval.endIndex] as WireRoutePoint;
    const connectionNames = this.getTraceConnectionNames(trace);

    for (let index = 0; index < output.points.length - 1; index++) {
      const proposedWidth = Math.max(
        output.traceWidth,
        index === 0 ? originalStart.width : 0,
        index === output.points.length - 2 ? originalEnd.width : 0,
      );
      if (
        this.obstacleIndex.collides({
          start: output.points[index]!,
          end: output.points[index + 1]!,
          layer: originalStart.layer,
          width: proposedWidth,
          connectionNames,
          ignoreTraceIndex: this.traceIndex,
          ignoreRouteRange: {
            start: Math.max(0, interval.startIndex - 1),
            end: Math.min(trace.route.length - 1, interval.endIndex + 1),
          },
        })
      ) {
        return true;
      }
    }
    return false;
  }

  private gridRouteBoundaryCollides(output: GridRouteOutput) {
    const trace = this.traces[this.traceIndex]!;
    const interval = this.currentIntervals[this.intervalCursor]!;
    const connectionNames = this.getTraceConnectionNames(trace);
    const boundaries = [
      {
        startIndex: interval.startIndex - 1,
        endIndex: interval.startIndex,
      },
      { startIndex: interval.endIndex, endIndex: interval.endIndex + 1 },
    ];

    for (const boundary of boundaries) {
      const start = trace.route[boundary.startIndex];
      const end = trace.route[boundary.endIndex];
      if (!isWire(start) || !isWire(end) || start.layer !== end.layer) {
        continue;
      }
      if (
        this.obstacleIndex.collides({
          start,
          end,
          layer: start.layer,
          // Core's joint/transition clearance is conservative around route
          // points, so validate both endpoint widths at splice boundaries.
          width: Math.max(start.width, end.width, output.traceWidth),
          connectionNames,
          ignoreTraceIndex: this.traceIndex,
          ignoreRouteRange: {
            start: boundary.startIndex,
            end: boundary.endIndex,
          },
        })
      ) {
        return true;
      }
    }
    return false;
  }

  private canExpandSegmentAndEndpoints(
    trace: SimplifiedPcbTrace,
    segmentIndex: number,
    connectionNames: string[],
    targetWidth = this.nominalTraceWidth,
  ) {
    const firstAffectedSegment = Math.max(0, segmentIndex - 1);
    const lastAffectedSegment = Math.min(
      trace.route.length - 2,
      segmentIndex + 1,
    );

    for (
      let affectedIndex = firstAffectedSegment;
      affectedIndex <= lastAffectedSegment;
      affectedIndex++
    ) {
      const affectedStart = trace.route[affectedIndex];
      const affectedEnd = trace.route[affectedIndex + 1];
      if (
        !isWire(affectedStart) ||
        !isWire(affectedEnd) ||
        affectedStart.layer !== affectedEnd.layer
      ) {
        continue;
      }
      const touchesExpandedPoint =
        affectedIndex <= segmentIndex + 1 && affectedIndex + 1 >= segmentIndex;
      // Although a serialized wire segment takes its width from its first
      // point, core validates the copper transition around both endpoints.
      // Checking adjacent segments at the larger endpoint width keeps the
      // standalone solver aligned with the fully rendered board DRC.
      const proposedWidth = Math.max(
        affectedStart.width,
        affectedEnd.width,
        touchesExpandedPoint ? targetWidth : 0,
      );
      if (
        this.obstacleIndex.collides({
          start: affectedStart,
          end: affectedEnd,
          layer: affectedStart.layer,
          width: proposedWidth,
          connectionNames,
          ignoreTraceIndex: this.traceIndex,
          ignoreRouteRange: {
            start: firstAffectedSegment,
            end: lastAffectedSegment + 1,
          },
        })
      ) {
        return false;
      }
    }
    return true;
  }

  private findMaximumSafeInPlaceWidth(
    trace: SimplifiedPcbTrace,
    segmentIndex: number,
    connectionNames: string[],
  ) {
    const start = trace.route[segmentIndex];
    const end = trace.route[segmentIndex + 1];
    if (!isWire(start) || !isWire(end)) return 0;
    const currentWidth = Math.min(start.width, end.width);
    if (
      this.probeInPlaceWidth(
        trace,
        segmentIndex,
        connectionNames,
        this.nominalTraceWidth,
      )
    ) {
      return this.nominalTraceWidth;
    }

    let lowerWidth = currentWidth;
    let upperWidth = this.nominalTraceWidth;
    for (let probe = 0; probe < 7; probe++) {
      const candidateWidth = (lowerWidth + upperWidth) / 2;
      if (candidateWidth <= lowerWidth + WIDTH_EPSILON) break;
      if (
        this.probeInPlaceWidth(
          trace,
          segmentIndex,
          connectionNames,
          candidateWidth,
        )
      ) {
        lowerWidth = candidateWidth;
      } else {
        upperWidth = candidateWidth;
      }
    }

    const quantum = this.nominalTraceWidth >= 0.5 ? 0.025 : 0.0125;
    const quantizedWidth = Math.max(
      currentWidth,
      Math.floor((lowerWidth + WIDTH_EPSILON) / quantum) * quantum,
    );
    if (
      quantizedWidth > currentWidth + WIDTH_EPSILON &&
      this.probeInPlaceWidth(
        trace,
        segmentIndex,
        connectionNames,
        quantizedWidth,
      )
    ) {
      return quantizedWidth;
    }
    return currentWidth;
  }

  private probeInPlaceWidth(
    trace: SimplifiedPcbTrace,
    segmentIndex: number,
    connectionNames: string[],
    width: number,
  ) {
    this.inPlaceWidthProbeCount++;
    return this.canExpandSegmentAndEndpoints(
      trace,
      segmentIndex,
      connectionNames,
      width,
    );
  }

  private maximizeGridRouteWidth(output: GridRouteOutput) {
    if (output.traceWidth >= this.nominalTraceWidth - WIDTH_EPSILON) {
      return output;
    }
    let lowerWidth = output.traceWidth;
    let upperWidth = this.nominalTraceWidth;
    for (let probe = 0; probe < 7; probe++) {
      const candidateWidth = (lowerWidth + upperWidth) / 2;
      const candidate = { ...output, traceWidth: candidateWidth };
      if (
        !this.gridRouteReplacementCollides(candidate) &&
        !this.gridRouteBoundaryCollides(candidate)
      ) {
        lowerWidth = candidateWidth;
      } else {
        upperWidth = candidateWidth;
      }
    }

    const quantum = this.nominalTraceWidth >= 0.5 ? 0.025 : 0.0125;
    const quantizedWidth = Math.max(
      output.traceWidth,
      Math.floor((lowerWidth + WIDTH_EPSILON) / quantum) * quantum,
    );
    if (quantizedWidth > output.traceWidth + WIDTH_EPSILON) {
      const candidate = { ...output, traceWidth: quantizedWidth };
      if (
        !this.gridRouteReplacementCollides(candidate) &&
        !this.gridRouteBoundaryCollides(candidate)
      ) {
        this.pathWidthUpgradeCount++;
        return candidate;
      }
    }
    return output;
  }

  private getExponentialIntervalCandidates(
    trace: SimplifiedPcbTrace,
    blockedSegmentIndex: number,
    nominalWidth: number,
  ) {
    const anchors = this.getExponentialIndices(
      trace,
      blockedSegmentIndex,
      -1,
      nominalWidth,
      5,
    );
    const targets = this.getExponentialIndices(
      trace,
      blockedSegmentIndex,
      1,
      nominalWidth,
      10,
    ).filter((index) => index > blockedSegmentIndex);
    const intervals: Array<{
      startIndex: number;
      endIndex: number;
      routeLength: number;
    }> = [];

    for (const startIndex of anchors) {
      for (const endIndex of targets) {
        const routeLength = this.getRouteIntervalLength(
          trace,
          startIndex,
          endIndex,
        );
        if (routeLength > 10 + WIDTH_EPSILON) continue;
        intervals.push({ startIndex, endIndex, routeLength });
      }
    }

    return intervals
      .sort((a, b) => a.routeLength - b.routeLength)
      .filter(
        (interval, index, all) =>
          all.findIndex(
            (candidate) =>
              candidate.startIndex === interval.startIndex &&
              candidate.endIndex === interval.endIndex,
          ) === index,
      )
      .slice(0, 10)
      .map(({ startIndex, endIndex }) => ({ startIndex, endIndex }));
  }

  private getExponentialIndices(
    trace: SimplifiedPcbTrace,
    originIndex: number,
    direction: -1 | 1,
    nominalWidth: number,
    maximumDistance: number,
  ) {
    const indices = [originIndex];
    let cumulativeDistance = 0;
    let threshold = Math.max(nominalWidth, 0.3);
    let currentIndex = originIndex;
    let furthestIndex = originIndex;

    while (true) {
      const nextIndex = currentIndex + direction;
      if (nextIndex < 0 || nextIndex >= trace.route.length) break;
      const current = trace.route[currentIndex];
      const next = trace.route[nextIndex];
      if (!isWire(current) || !isWire(next) || current.layer !== next.layer)
        break;
      const segmentLength = distance(current, next);
      if (cumulativeDistance + segmentLength > maximumDistance + WIDTH_EPSILON)
        break;
      cumulativeDistance += segmentLength;
      currentIndex = nextIndex;
      furthestIndex = nextIndex;
      if (cumulativeDistance + WIDTH_EPSILON >= threshold) {
        indices.push(nextIndex);
        threshold *= 2;
      }
    }
    if (!indices.includes(furthestIndex)) indices.push(furthestIndex);
    return indices;
  }

  private getRouteIntervalLength(
    trace: SimplifiedPcbTrace,
    startIndex: number,
    endIndex: number,
  ) {
    let length = 0;
    for (let index = startIndex; index < endIndex; index++) {
      const start = trace.route[index];
      const end = trace.route[index + 1];
      if (!isWire(start) || !isWire(end) || start.layer !== end.layer) {
        return Number.POSITIVE_INFINITY;
      }
      length += distance(start, end);
    }
    return length;
  }

  private getCandidateWidths(nominalWidth: number) {
    const minimumWidth = this.inputProblem.minTraceWidth;
    return uniqueDescending([
      nominalWidth,
      nominalWidth * 0.875,
      nominalWidth * 0.75,
      nominalWidth * 0.625,
      nominalWidth * 0.5,
      nominalWidth * 0.375,
      nominalWidth * 0.25,
      minimumWidth,
    ]).filter((width) => width >= minimumWidth - WIDTH_EPSILON);
  }

  private getGridResolutions(traceWidth: number) {
    return uniqueDescending([
      Math.max(0.1, Math.min(0.5, traceWidth / 2)),
      Math.max(0.1, Math.min(0.25, traceWidth / 3)),
    ]);
  }

  private resolveNominalTraceWidth(trace: SimplifiedPcbTrace) {
    const connection = this.findConnectionForTrace(trace);
    return Math.max(
      connection?.nominalTraceWidth ??
        connection?.width ??
        this.inputProblem.nominalTraceWidth ??
        this.inputProblem.minTraceWidth,
      this.inputProblem.minTraceWidth,
    );
  }

  private findConnectionForTrace(trace: SimplifiedPcbTrace) {
    const traceNames = this.getTraceConnectionNames(trace);
    return this.inputProblem.connections.find((candidate) =>
      this.connectionMatchesTrace(candidate, traceNames),
    );
  }

  private connectionMatchesTrace(
    connection: SimpleRouteConnection,
    traceNames: string[],
  ) {
    return [
      connection.name,
      connection.source_trace_id,
      connection.rootConnectionName,
      ...(connection.mergedConnectionNames ?? []),
    ]
      .filter((name): name is string => Boolean(name))
      .some((name) => traceNames.includes(name));
  }

  private getTraceConnectionNames(trace: SimplifiedPcbTrace) {
    return [
      trace.connection_name,
      trace.source_trace_id,
      trace.rootConnectionName,
      ...(trace.mergedConnectionNames ?? []),
    ].filter((name): name is string => Boolean(name));
  }

  private traceMeetsNominalWidth(
    trace: SimplifiedPcbTrace,
    nominalWidth: number,
  ) {
    return trace.route.every(
      (point) =>
        point.route_type !== "wire" ||
        point.width >= nominalWidth - WIDTH_EPSILON,
    );
  }

  private findNextUnderWidthSegment(
    trace: SimplifiedPcbTrace,
    startIndex: number,
    nominalWidth: number,
  ) {
    for (let index = startIndex; index < trace.route.length - 1; index++) {
      const start = trace.route[index];
      const end = trace.route[index + 1];
      if (!isWire(start) || !isWire(end) || start.layer !== end.layer) continue;
      if (
        start.width < nominalWidth - WIDTH_EPSILON ||
        end.width < nominalWidth - WIDTH_EPSILON
      ) {
        return index;
      }
    }
    return -1;
  }

  private rebuildObstacleIndex() {
    this.obstacleIndex = new SpatialObstacleIndex(
      this.inputProblem,
      this.traces,
      this.traceIndex,
      [],
      this.connectionNameResolver,
    );
  }

  private createStats() {
    return {
      phase: this.phase,
      pass: this.passIndex + 1,
      completedPassCount: this.completedPassCount,
      lastNormalizedWidthDeficitGain: this.lastNormalizedWidthDeficitGain,
      normalizedWidthDeficitGainByPass: [
        ...this.normalizedWidthDeficitGainByPass,
      ],
      plateauReached: this.plateauReached,
      traceIndex: this.traceIndex,
      traceCount: this.traces.length,
      routeSegmentIndex: this.routeSegmentIndex,
      nominalTraceWidth: this.nominalTraceWidth,
      intervalCursor: this.intervalCursor,
      intervalCount: this.currentIntervals.length,
      candidateWidth: this.candidateWidths[this.widthCursor],
      gridSize: this.gridResolutions[this.resolutionCursor],
      gridOffsetVariant: this.offsetCursor,
      keptTraceCount: this.keptTraceCount,
      recreatedTraceCount: this.recreatedTraceCount,
      expandedSegmentCount: this.expandedSegmentCount,
      intermediateExpandedSegmentCount: this.intermediateExpandedSegmentCount,
      pathWidthUpgradeCount: this.pathWidthUpgradeCount,
      inPlaceWidthProbeCount: this.inPlaceWidthProbeCount,
      reroutedSegmentCount: this.reroutedSegmentCount,
      unresolvedSegmentCount: this.unresolvedSegmentCount,
      attemptedGridCount: this.attemptedGridCount,
      attemptedInflationCount: this.attemptedInflationCount,
      activeInflationWidth: this.activeInflationWidth,
      pushedTraceCount: this.pushedTraceCount,
      elasticPushedTraceCount: this.elasticPushedTraceCount,
      spatialIndexRectCount: this.obstacleIndex.items.length,
    };
  }

  computeProgress() {
    if (this.traces.length === 0) return 1;
    return Math.min(
      0.99,
      (this.passIndex +
        Math.max(0, this.traceOrderCursor) / this.traces.length) /
        this.maxPassCount,
    );
  }

  override getConstructorParams() {
    return [this.inputProblem];
  }

  override getOutput(): PowerTraceExpanderOutput {
    return this.traces;
  }

  override visualize(): GraphicsObject {
    const lines: NonNullable<GraphicsObject["lines"]> = [];
    for (let traceIndex = 0; traceIndex < this.traces.length; traceIndex++) {
      const trace = this.traces[traceIndex]!;
      const nominalWidth = this.resolveNominalTraceWidth(trace);
      for (
        let routeIndex = 0;
        routeIndex < trace.route.length - 1;
        routeIndex++
      ) {
        const start = trace.route[routeIndex];
        const end = trace.route[routeIndex + 1];
        if (!isWire(start) || !isWire(end) || start.layer !== end.layer)
          continue;
        const isCurrent =
          traceIndex === this.traceIndex &&
          routeIndex === this.routeSegmentIndex;
        const meetsWidth =
          start.width >= nominalWidth - WIDTH_EPSILON &&
          end.width >= nominalWidth - WIDTH_EPSILON;
        lines.push({
          points: [start, end],
          strokeColor: isCurrent
            ? "#ff8c00"
            : meetsWidth
              ? "#169c45"
              : "#cc3344",
          strokeWidth: Math.max(start.width, end.width),
        });
      }
    }
    return {
      coordinateSystem: "cartesian",
      title: `Power trace expander: ${this.phase}`,
      lines,
      points: [],
      circles: [],
      rects: this.obstacleIndex.items
        .filter((item) => item.kind === "obstacle")
        .slice(0, 2_000)
        .map((item) => ({
          center: {
            x: (item.minX + item.maxX) / 2,
            y: (item.minY + item.maxY) / 2,
          },
          width: item.maxX - item.minX,
          height: item.maxY - item.minY,
          fill: "rgba(80,80,80,0.12)",
          stroke: "rgba(80,80,80,0.35)",
        })),
      texts: [],
    };
  }
}
