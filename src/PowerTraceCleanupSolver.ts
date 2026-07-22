import type {
  SimpleRouteConnection,
  SimplifiedPcbTrace,
} from "@tscircuit/core";
import { BaseSolver } from "@tscircuit/solver-utils";
import type { GraphicsObject } from "graphics-debug";
import { ConnectionNameResolver } from "./ConnectionNameResolver";
import { clamp, distance, WIDTH_EPSILON } from "./geometry";
import { LocalTraceInflationSolver } from "./LocalTraceInflationSolver";
import { ObstacleAwareGridRouteSolver } from "./ObstacleAwareGridRouteSolver";
import {
  calculateOctilinearPaths,
  countNonOctilinearSegments,
  getPathLength,
} from "./octilinear";
import { SpatialObstacleIndex } from "./SpatialObstacleIndex";
import type {
  InflationCorridorSegment,
  Point,
  PowerTraceCleanupOutput,
  PowerTraceCleanupProblem,
  WireRoutePoint,
} from "./types";

type CleanupPhase =
  | "scan-via-pairs"
  | "scan-simplification"
  | "evaluate-candidate"
  | "shove-clearance"
  | "route-via-pair"
  | "complete";

type CleanupKind = "via-pair" | "simplification";

type RouteQuality = {
  length: number;
  deficitArea: number;
  conservativeDeficitArea: number;
  nominalLength: number;
  conservativeNominalLength: number;
  nonOctilinearSegmentCount: number;
  pointCount: number;
};

type CleanupCandidate = {
  kind: CleanupKind;
  traceIndex: number;
  startIndex: number;
  endIndex: number;
  layer: string;
  points: Point[];
  width: number;
  originalQuality: RouteQuality;
};

type ViaGridAttempt = {
  traceIndex: number;
  startIndex: number;
  endIndex: number;
  layer: string;
  originalQuality: RouteQuality;
  widths: number[];
  widthCursor: number;
  gridSizes: number[];
  gridSizeCursor: number;
  offsetCursor: number;
};

const GRID_OFFSETS = [
  { x: 0, y: 0 },
  { x: 0.5, y: 0.5 },
] as const;

const isWire = (
  point: SimplifiedPcbTrace["route"][number] | undefined,
): point is WireRoutePoint => point?.route_type === "wire";

const uniqueDescending = (values: number[]) =>
  [...new Set(values.map((value) => Number(value.toFixed(6))))].sort(
    (a, b) => b - a,
  );

/**
 * Post-route cleanup for wide traces. It removes same-layer via excursions,
 * then rewrites unnecessarily complex or arbitrary-angle paths as compact
 * 0/45/90-degree paths. A lower-width neighboring trace may be displaced to
 * create extra clearance, but that displacement is transactional: it is
 * rolled back unless the proposed power path is ultimately accepted.
 */
export class PowerTraceCleanupSolver extends BaseSolver {
  readonly inputProblem: PowerTraceCleanupProblem;
  traces: SimplifiedPcbTrace[];
  obstacleIndex: SpatialObstacleIndex;
  phase: CleanupPhase = "scan-via-pairs";

  traceCursor = 0;
  routeCursor = 0;
  candidateCursor = 0;
  clearanceTierCursor = 0;
  attemptedCandidateCount = 0;
  attemptedClearanceShoveCount = 0;
  attemptedViaGridCount = 0;
  committedClearanceShoveCount = 0;
  viaPairCountRemoved = 0;
  viaCountRemoved = 0;
  simplifiedPathCount = 0;
  normalizedSegmentCount = 0;
  achievedExtraClearanceCount = 0;

  private readonly connectionNameResolver: ConnectionNameResolver;
  private readonly traceIndices: number[];
  private readonly maxRerouteLength: number;
  private readonly clearancePaddingTiers: number[];
  private readonly initialTraceLengths = new Map<number, number>();
  private candidates: CleanupCandidate[] = [];
  private candidateShoveCount = 0;
  private rollbackTraces: SimplifiedPcbTrace[] | null = null;
  private baseCandidateValidated = false;
  private activeShovePadding = 0;
  private viaGridAttempt: ViaGridAttempt | null = null;
  private candidateSetMayUseGridFallback = false;
  private resumePhase: Exclude<
    CleanupPhase,
    "evaluate-candidate" | "shove-clearance" | "complete"
  > = "scan-via-pairs";

  declare activeSubSolver:
    | LocalTraceInflationSolver
    | ObstacleAwareGridRouteSolver
    | null;

  constructor(inputProblem: PowerTraceCleanupProblem) {
    super();
    this.inputProblem = structuredClone(inputProblem);
    this.traces = structuredClone(inputProblem.traces);
    this.connectionNameResolver = new ConnectionNameResolver(
      inputProblem.simpleRouteJson,
      this.traces,
    );
    this.maxRerouteLength = inputProblem.maxRerouteLength ?? 10;
    this.clearancePaddingTiers = uniqueDescending([
      ...(inputProblem.clearancePaddingTiers ?? [0.1, 0.05, 0]),
      0,
    ]).filter((padding) => padding >= 0);
    const requestedIndices = inputProblem.traceIndices
      ? new Set(inputProblem.traceIndices)
      : null;
    this.traceIndices = this.traces.flatMap((trace, traceIndex) =>
      (!requestedIndices || requestedIndices.has(traceIndex)) &&
      this.resolveNominalTraceWidth(trace) >= 0.5 - WIDTH_EPSILON
        ? [traceIndex]
        : [],
    );
    for (const traceIndex of this.traceIndices) {
      this.initialTraceLengths.set(
        traceIndex,
        this.measureTraceLength(this.traces[traceIndex]!),
      );
    }
    this.obstacleIndex = this.createObstacleIndex();
    this.activeSubSolver = null;
    this.MAX_ITERATIONS = 1_000_000;
    this.stats = this.createStats();
  }

  override getSolverName() {
    return "PowerTraceCleanupSolver";
  }

  override _step() {
    if (this.activeSubSolver) {
      this.stepActiveShoveSolver();
      this.stats = this.createStats();
      return;
    }

    switch (this.phase) {
      case "scan-via-pairs":
        this.scanNextViaPair();
        break;
      case "scan-simplification":
        this.scanNextSimplification();
        break;
      case "evaluate-candidate":
        this.evaluateCurrentCandidate();
        break;
      case "shove-clearance":
        // The active shove solver is stepped above.
        break;
      case "route-via-pair":
        this.startNextViaGridCandidate();
        break;
      case "complete":
        this.solved = true;
        break;
    }
    this.stats = this.createStats();
  }

  private scanNextViaPair() {
    const traceIndex = this.traceIndices[this.traceCursor];
    if (traceIndex === undefined) {
      this.traceCursor = 0;
      this.routeCursor = 0;
      this.phase = "scan-simplification";
      return;
    }
    const trace = this.traces[traceIndex]!;
    const firstViaIndex = trace.route.findIndex(
      (point, index) => index >= this.routeCursor && point.route_type === "via",
    );
    if (firstViaIndex === -1) {
      this.advanceTrace();
      return;
    }
    const secondViaRelativeIndex = trace.route
      .slice(firstViaIndex + 1)
      .findIndex((point) => point.route_type === "via");
    if (secondViaRelativeIndex === -1) {
      this.advanceTrace();
      return;
    }
    const secondViaIndex = firstViaIndex + 1 + secondViaRelativeIndex;
    const startIndex = firstViaIndex - 1;
    const endIndex = secondViaIndex + 1;
    const start = trace.route[startIndex];
    const end = trace.route[endIndex];
    this.routeCursor = firstViaIndex + 1;
    if (
      !isWire(start) ||
      !isWire(end) ||
      start.layer !== end.layer ||
      distance(start, end) > this.maxRerouteLength + WIDTH_EPSILON
    ) {
      return;
    }

    const candidates = this.createCandidates({
      kind: "via-pair",
      traceIndex,
      startIndex,
      endIndex,
    });
    if (candidates.length === 0) return;
    this.beginCandidates(candidates, "scan-via-pairs", true);
  }

  private scanNextSimplification() {
    const traceIndex = this.traceIndices[this.traceCursor];
    if (traceIndex === undefined) {
      this.phase = "complete";
      return;
    }
    const trace = this.traces[traceIndex]!;
    const startIndex = this.routeCursor;
    const start = trace.route[startIndex];
    if (!isWire(start) || startIndex >= trace.route.length - 1) {
      if (startIndex >= trace.route.length - 1) this.advanceTrace();
      else this.routeCursor++;
      return;
    }

    let accumulatedLength = 0;
    const endIndices: number[] = [];
    for (
      let endIndex = startIndex + 1;
      endIndex < trace.route.length;
      endIndex++
    ) {
      const prior = trace.route[endIndex - 1];
      const end = trace.route[endIndex];
      if (
        !isWire(prior) ||
        !isWire(end) ||
        prior.layer !== start.layer ||
        end.layer !== start.layer
      )
        break;
      accumulatedLength += distance(prior, end);
      if (accumulatedLength > this.maxRerouteLength + WIDTH_EPSILON) break;
      const quality = this.measureRouteRange(trace, startIndex, endIndex);
      if (quality.nonOctilinearSegmentCount > 0 || quality.pointCount > 3) {
        endIndices.push(endIndex);
      }
    }

    const candidates = endIndices
      .slice(-6)
      .reverse()
      .flatMap((endIndex) =>
        this.createCandidates({
          kind: "simplification",
          traceIndex,
          startIndex,
          endIndex,
        }),
      );
    if (candidates.length === 0) {
      this.routeCursor++;
      return;
    }
    this.beginCandidates(candidates, "scan-simplification");
  }

  private createCandidates({
    kind,
    traceIndex,
    startIndex,
    endIndex,
  }: {
    kind: CleanupKind;
    traceIndex: number;
    startIndex: number;
    endIndex: number;
  }) {
    const trace = this.traces[traceIndex]!;
    const start = trace.route[startIndex];
    const end = trace.route[endIndex];
    if (!isWire(start) || !isWire(end) || start.layer !== end.layer) return [];
    const nominalWidth = this.resolveNominalTraceWidth(trace);
    const originalQuality = this.measureRouteRange(trace, startIndex, endIndex);
    const candidates: CleanupCandidate[] = [];

    for (const points of calculateOctilinearPaths(start, end)) {
      const pathLength = getPathLength(points);
      if (
        pathLength > this.maxRerouteLength + WIDTH_EPSILON ||
        (kind === "simplification" &&
          (pathLength > originalQuality.length * 1.1 + WIDTH_EPSILON ||
            this.measureTraceLength(trace) -
              originalQuality.length +
              pathLength >
              (this.initialTraceLengths.get(traceIndex) ??
                this.measureTraceLength(trace)) *
                1.01 +
                WIDTH_EPSILON))
      ) {
        continue;
      }
      const requiredWidth =
        pathLength <= WIDTH_EPSILON
          ? nominalWidth
          : nominalWidth - originalQuality.deficitArea / pathLength;
      if (requiredWidth > nominalWidth + WIDTH_EPSILON) continue;
      const quantizedRequiredWidth =
        Math.ceil(
          Math.max(
            this.inputProblem.simpleRouteJson.minTraceWidth,
            requiredWidth,
          ) /
            0.05 -
            WIDTH_EPSILON,
        ) * 0.05;
      const widths = uniqueDescending(
        [
          nominalWidth,
          Math.min(nominalWidth, quantizedRequiredWidth),
          Math.min(
            nominalWidth,
            Math.max(
              this.inputProblem.simpleRouteJson.minTraceWidth,
              requiredWidth,
            ),
          ),
        ].map((width) => Math.max(width, start.width)),
      );
      for (const width of widths) {
        const candidateQuality = this.measureCandidate(
          points,
          width,
          nominalWidth,
          end.width,
        );
        if (
          candidateQuality.deficitArea >
            originalQuality.deficitArea + WIDTH_EPSILON ||
          candidateQuality.conservativeDeficitArea >
            originalQuality.conservativeDeficitArea + WIDTH_EPSILON ||
          !this.preservesCoverage(candidateQuality, originalQuality)
        ) {
          continue;
        }
        if (
          kind === "simplification" &&
          originalQuality.nonOctilinearSegmentCount === 0 &&
          !(
            candidateQuality.pointCount < originalQuality.pointCount &&
            candidateQuality.length < originalQuality.length - WIDTH_EPSILON
          )
        ) {
          continue;
        }
        candidates.push({
          kind,
          traceIndex,
          startIndex,
          endIndex,
          layer: start.layer,
          points,
          width,
          originalQuality,
        });
      }
    }
    return candidates.slice(0, 18);
  }

  private beginCandidates(
    candidates: CleanupCandidate[],
    resumePhase: typeof this.resumePhase,
    mayUseGridFallback = false,
  ) {
    this.candidates = candidates;
    this.candidateCursor = 0;
    this.clearanceTierCursor = 0;
    this.candidateShoveCount = 0;
    this.rollbackTraces = null;
    this.baseCandidateValidated = false;
    this.resumePhase = resumePhase;
    this.candidateSetMayUseGridFallback = mayUseGridFallback;
    this.phase = "evaluate-candidate";
  }

  private evaluateCurrentCandidate() {
    const candidate = this.candidates[this.candidateCursor];
    if (!candidate) {
      this.finishCandidateSet(false);
      return;
    }
    if (!this.baseCandidateValidated) {
      if (!this.candidateCollides(candidate, 0)) {
        if (this.candidateShoveCount > 0) {
          this.applyCandidate(candidate, 0);
          return;
        }
        this.baseCandidateValidated = true;
        this.clearanceTierCursor = 0;
        return;
      }
      const requiredPushes = this.getPushableTraceIndices(candidate, 0);
      if (
        requiredPushes &&
        this.candidateShoveCount < 2 &&
        this.attemptedClearanceShoveCount < 48
      ) {
        this.startClearanceShove(candidate, 0);
        return;
      }
      this.advanceCandidate();
      return;
    }

    const clearancePadding =
      this.clearancePaddingTiers[this.clearanceTierCursor];
    if (clearancePadding === undefined || clearancePadding <= WIDTH_EPSILON) {
      this.applyCandidate(candidate, 0);
      return;
    }
    this.attemptedCandidateCount++;
    if (!this.candidateCollides(candidate, clearancePadding)) {
      this.applyCandidate(candidate, clearancePadding);
      return;
    }

    const pushableTraceIndices = this.getPushableTraceIndices(
      candidate,
      clearancePadding,
    );
    if (
      pushableTraceIndices &&
      this.candidateShoveCount < 2 &&
      this.attemptedClearanceShoveCount < 48
    ) {
      this.startClearanceShove(candidate, clearancePadding);
      return;
    }
    this.rollbackCandidateShoves();
    this.clearanceTierCursor++;
    this.candidateShoveCount = 0;
  }

  private advanceCandidate() {
    this.rollbackCandidateShoves();
    this.candidateCursor++;
    this.clearanceTierCursor = 0;
    this.candidateShoveCount = 0;
    this.baseCandidateValidated = false;
  }

  private candidateCollides(
    candidate: CleanupCandidate,
    clearancePadding: number,
  ) {
    const trace = this.traces[candidate.traceIndex]!;
    const connectionNames = this.getTraceConnectionNames(trace);
    for (let index = 0; index < candidate.points.length - 1; index++) {
      const segmentWidth = this.getCandidateSegmentWidth(candidate, index);
      if (
        this.obstacleIndex.collides({
          start: candidate.points[index]!,
          end: candidate.points[index + 1]!,
          layer: candidate.layer,
          width: segmentWidth + clearancePadding * 2,
          connectionNames,
          ignoreTraceIndex: candidate.traceIndex,
          ignoreRouteRange: {
            start: Math.max(0, candidate.startIndex - 1),
            end: Math.min(trace.route.length - 1, candidate.endIndex + 1),
          },
        })
      ) {
        return true;
      }
    }
    return false;
  }

  private getPushableTraceIndices(
    candidate: CleanupCandidate,
    clearancePadding: number,
  ) {
    const trace = this.traces[candidate.traceIndex]!;
    const connectionNames = this.getTraceConnectionNames(trace);
    const pushableTraceIndices = new Set<number>();
    for (let index = 0; index < candidate.points.length - 1; index++) {
      const segmentWidth = this.getCandidateSegmentWidth(candidate, index);
      const query = {
        start: candidate.points[index]!,
        end: candidate.points[index + 1]!,
        layer: candidate.layer,
        width: segmentWidth + clearancePadding * 2,
        connectionNames,
        ignoreTraceIndex: candidate.traceIndex,
        ignoreRouteRange: {
          start: Math.max(0, candidate.startIndex - 1),
          end: Math.min(trace.route.length - 1, candidate.endIndex + 1),
        },
      };
      if (!this.obstacleIndex.collides(query)) continue;
      const collisions = this.obstacleIndex.findCollisions(query);
      if (collisions.length === 0) return null;
      for (const collision of collisions) {
        if (
          collision.kind !== "trace" ||
          collision.traceIndex === undefined ||
          collision.traceIndex === candidate.traceIndex
        ) {
          return null;
        }
        const blockingTrace = this.traces[collision.traceIndex];
        if (
          !blockingTrace ||
          this.resolveNominalTraceWidth(blockingTrace) >=
            candidate.width - WIDTH_EPSILON
        ) {
          return null;
        }
        pushableTraceIndices.add(collision.traceIndex);
      }
    }
    return pushableTraceIndices.size > 0 && pushableTraceIndices.size <= 2
      ? [...pushableTraceIndices]
      : null;
  }

  private startClearanceShove(
    candidate: CleanupCandidate,
    clearancePadding: number,
  ) {
    this.rollbackTraces ??= structuredClone(this.traces);
    this.activeShovePadding = clearancePadding;
    const corridorWidth = candidate.width + clearancePadding * 2;
    const corridor: InflationCorridorSegment[] = candidate.points
      .slice(0, -1)
      .map((start, index) => ({
        start,
        end: candidate.points[index + 1]!,
        layer: candidate.layer,
        width:
          this.getCandidateSegmentWidth(candidate, index) +
          clearancePadding * 2,
      }));
    this.attemptedClearanceShoveCount++;
    this.activeSubSolver = new LocalTraceInflationSolver(
      {
        simpleRouteJson: this.inputProblem.simpleRouteJson,
        traces: this.traces,
        powerTraceIndex: candidate.traceIndex,
        nominalPowerWidth: corridorWidth,
        pushOnlyNominalWidthsBelow: candidate.width,
        corridor,
        maxRerouteLength: this.maxRerouteLength,
      },
      this.connectionNameResolver,
    );
    this.phase = "shove-clearance";
  }

  private getCandidateSegmentWidth(
    candidate: CleanupCandidate,
    segmentIndex: number,
  ) {
    const trace = this.traces[candidate.traceIndex]!;
    const originalStart = trace.route[candidate.startIndex];
    const originalEnd = trace.route[candidate.endIndex];
    let width = candidate.width;
    if (segmentIndex === 0 && isWire(originalStart)) {
      width = Math.max(width, originalStart.width);
    }
    if (segmentIndex === candidate.points.length - 2 && isWire(originalEnd)) {
      width = Math.max(width, originalEnd.width);
    }
    return width;
  }

  private stepActiveShoveSolver() {
    const solver = this.activeSubSolver!;
    solver.step();
    if (!solver.solved && !solver.failed) return;
    if (solver instanceof ObstacleAwareGridRouteSolver) {
      this.finishViaGridSolver(solver);
      return;
    }
    this.activeSubSolver = null;
    this.phase = "evaluate-candidate";
    if (solver.solved) {
      const output = solver.getOutput();
      if (output) {
        this.traces = output.traces;
        this.candidateShoveCount++;
        this.rebuildObstacleIndex();
        return;
      }
    }
    this.failedSubSolvers ??= [];
    this.failedSubSolvers.push(solver);
    this.rollbackCandidateShoves();
    if (this.activeShovePadding <= WIDTH_EPSILON) {
      this.advanceCandidate();
    } else {
      this.clearanceTierCursor++;
    }
    this.candidateShoveCount = 0;
  }

  private rollbackCandidateShoves() {
    if (!this.rollbackTraces) return;
    this.traces = this.rollbackTraces;
    this.rollbackTraces = null;
    this.rebuildObstacleIndex();
  }

  private applyCandidate(
    candidate: CleanupCandidate,
    clearancePadding: number,
  ) {
    const trace = this.traces[candidate.traceIndex]!;
    const originalStart = trace.route[candidate.startIndex] as WireRoutePoint;
    const originalEnd = trace.route[candidate.endIndex] as WireRoutePoint;
    const replacement: WireRoutePoint[] = candidate.points.map(
      (point, index) => ({
        ...(index === 0
          ? originalStart
          : index === candidate.points.length - 1
            ? originalEnd
            : {
                route_type: "wire" as const,
                layer: candidate.layer,
                width: candidate.width,
              }),
        x: point.x,
        y: point.y,
        layer: candidate.layer,
        width:
          index === candidate.points.length - 1
            ? originalEnd.width
            : candidate.width,
      }),
    );
    const removedRoute = trace.route.slice(
      candidate.startIndex,
      candidate.endIndex + 1,
    );
    const removedNonOctilinearCount =
      candidate.originalQuality.nonOctilinearSegmentCount;
    trace.route.splice(
      candidate.startIndex,
      candidate.endIndex - candidate.startIndex + 1,
      ...replacement,
    );

    if (candidate.kind === "via-pair") {
      const removedViaCount = removedRoute.filter(
        (point) => point.route_type === "via",
      ).length;
      this.viaPairCountRemoved++;
      this.viaCountRemoved += removedViaCount;
      this.routeCursor = Math.max(0, candidate.startIndex - 1);
    } else {
      this.simplifiedPathCount++;
      this.normalizedSegmentCount += removedNonOctilinearCount;
      this.routeCursor =
        candidate.startIndex + Math.max(1, replacement.length - 1);
    }
    this.committedClearanceShoveCount += this.candidateShoveCount;
    if (clearancePadding > WIDTH_EPSILON) {
      this.achievedExtraClearanceCount++;
    }
    this.rollbackTraces = null;
    this.candidateShoveCount = 0;
    this.rebuildObstacleIndex();
    this.finishCandidateSet(true);
  }

  private finishCandidateSet(accepted: boolean) {
    const gridFallbackCandidate = this.candidates[0];
    const gridFallbackWidths = uniqueDescending(
      this.candidates
        .filter((candidate) => candidate.kind === "via-pair")
        .map((candidate) => candidate.width),
    );
    this.rollbackCandidateShoves();
    this.candidates = [];
    this.candidateCursor = 0;
    this.clearanceTierCursor = 0;
    this.candidateShoveCount = 0;
    this.baseCandidateValidated = false;
    if (
      !accepted &&
      this.candidateSetMayUseGridFallback &&
      gridFallbackCandidate?.kind === "via-pair"
    ) {
      this.candidateSetMayUseGridFallback = false;
      this.beginViaGridAttempt(gridFallbackCandidate, gridFallbackWidths);
      return;
    }
    this.candidateSetMayUseGridFallback = false;
    if (!accepted) this.routeCursor++;
    this.phase = this.resumePhase;
  }

  private beginViaGridAttempt(candidate: CleanupCandidate, widths: number[]) {
    this.viaGridAttempt = {
      traceIndex: candidate.traceIndex,
      startIndex: candidate.startIndex,
      endIndex: candidate.endIndex,
      layer: candidate.layer,
      originalQuality: candidate.originalQuality,
      widths,
      widthCursor: 0,
      gridSizes: [],
      gridSizeCursor: 0,
      offsetCursor: 0,
    };
    this.phase = "route-via-pair";
  }

  private startNextViaGridCandidate() {
    const attempt = this.viaGridAttempt;
    if (!attempt) {
      this.phase = "scan-via-pairs";
      return;
    }
    if (attempt.widthCursor >= attempt.widths.length) {
      this.viaGridAttempt = null;
      this.routeCursor++;
      this.phase = "scan-via-pairs";
      return;
    }
    const width = attempt.widths[attempt.widthCursor]!;
    if (attempt.gridSizes.length === 0) {
      attempt.gridSizes = uniqueDescending([
        clamp(width / 2, 0.2, 0.4),
        clamp(width / 3, 0.15, 0.25),
      ]);
    }
    if (attempt.gridSizeCursor >= attempt.gridSizes.length) {
      attempt.widthCursor++;
      attempt.gridSizes = [];
      attempt.gridSizeCursor = 0;
      attempt.offsetCursor = 0;
      return;
    }
    if (attempt.offsetCursor >= GRID_OFFSETS.length) {
      attempt.gridSizeCursor++;
      attempt.offsetCursor = 0;
      return;
    }

    const trace = this.traces[attempt.traceIndex]!;
    const start = trace.route[attempt.startIndex];
    const end = trace.route[attempt.endIndex];
    if (!isWire(start) || !isWire(end)) {
      this.viaGridAttempt = null;
      this.routeCursor++;
      this.phase = "scan-via-pairs";
      return;
    }
    const gridSize = attempt.gridSizes[attempt.gridSizeCursor]!;
    const offset = GRID_OFFSETS[attempt.offsetCursor]!;
    this.attemptedViaGridCount++;
    this.activeSubSolver = new ObstacleAwareGridRouteSolver({
      start,
      end,
      layer: attempt.layer,
      traceWidth: width,
      gridSize,
      gridOffset: { x: offset.x * gridSize, y: offset.y * gridSize },
      connectionNames: this.getTraceConnectionNames(trace),
      obstacleIndex: this.obstacleIndex,
      ignoreTraceIndex: attempt.traceIndex,
      ignoreRouteRange: {
        start: Math.max(0, attempt.startIndex - 1),
        end: Math.min(trace.route.length - 1, attempt.endIndex + 1),
      },
      bounds: this.inputProblem.simpleRouteJson.bounds,
      searchPadding: Math.min(
        4,
        Math.max(2, distance(start, end) / 2, width * 3),
      ),
      requireOctilinear: true,
    });
  }

  private finishViaGridSolver(solver: ObstacleAwareGridRouteSolver) {
    const attempt = this.viaGridAttempt;
    this.activeSubSolver = null;
    if (solver.solved && attempt) {
      const output = solver.getOutput();
      const trace = this.traces[attempt.traceIndex];
      if (output && trace) {
        const nominalWidth = this.resolveNominalTraceWidth(trace);
        const quality = this.measureCandidate(
          output.points,
          output.traceWidth,
          nominalWidth,
          (trace.route[attempt.endIndex] as WireRoutePoint).width,
        );
        if (
          quality.nonOctilinearSegmentCount === 0 &&
          quality.length <= this.maxRerouteLength + WIDTH_EPSILON &&
          quality.deficitArea <=
            attempt.originalQuality.deficitArea + WIDTH_EPSILON &&
          quality.conservativeDeficitArea <=
            attempt.originalQuality.conservativeDeficitArea + WIDTH_EPSILON &&
          this.preservesCoverage(quality, attempt.originalQuality)
        ) {
          const candidate: CleanupCandidate = {
            kind: "via-pair",
            traceIndex: attempt.traceIndex,
            startIndex: attempt.startIndex,
            endIndex: attempt.endIndex,
            layer: attempt.layer,
            points: output.points,
            width: output.traceWidth,
            originalQuality: attempt.originalQuality,
          };
          this.viaGridAttempt = null;
          this.beginCandidates([candidate], "scan-via-pairs", false);
          return;
        }
      }
    }
    if (solver.failed) {
      this.failedSubSolvers ??= [];
      this.failedSubSolvers.push(solver);
    }
    if (attempt) attempt.offsetCursor++;
    this.phase = "route-via-pair";
  }

  private measureRouteRange(
    trace: SimplifiedPcbTrace,
    startIndex: number,
    endIndex: number,
  ): RouteQuality {
    const nominalWidth = this.resolveNominalTraceWidth(trace);
    let length = 0;
    let deficitArea = 0;
    let conservativeDeficitArea = 0;
    let nominalLength = 0;
    let conservativeNominalLength = 0;
    let nonOctilinearSegmentCount = 0;
    let pointCount = 0;
    for (let index = startIndex; index <= endIndex; index++) {
      if (isWire(trace.route[index])) pointCount++;
      if (index >= endIndex) continue;
      const start = trace.route[index];
      const end = trace.route[index + 1];
      if (!isWire(start) || !isWire(end) || start.layer !== end.layer) continue;
      const segmentLength = distance(start, end);
      length += segmentLength;
      deficitArea += segmentLength * Math.max(0, nominalWidth - start.width);
      if (start.width >= nominalWidth - WIDTH_EPSILON) {
        nominalLength += segmentLength;
      }
      conservativeDeficitArea +=
        segmentLength *
        Math.max(0, nominalWidth - Math.min(start.width, end.width));
      if (Math.min(start.width, end.width) >= nominalWidth - WIDTH_EPSILON) {
        conservativeNominalLength += segmentLength;
      }
      nonOctilinearSegmentCount += countNonOctilinearSegments([start, end]);
    }
    return {
      length,
      deficitArea,
      conservativeDeficitArea,
      nominalLength,
      conservativeNominalLength,
      nonOctilinearSegmentCount,
      pointCount,
    };
  }

  private measureTraceLength(trace: SimplifiedPcbTrace) {
    let length = 0;
    for (let index = 0; index < trace.route.length - 1; index++) {
      const start = trace.route[index];
      const end = trace.route[index + 1];
      if (isWire(start) && isWire(end) && start.layer === end.layer) {
        length += distance(start, end);
      }
    }
    return length;
  }

  private measureCandidate(
    points: Point[],
    width: number,
    nominalWidth: number,
    endWidth = width,
  ): RouteQuality {
    const length = getPathLength(points);
    let conservativeDeficitArea = 0;
    let nominalLength = 0;
    let conservativeNominalLength = 0;
    for (let index = 0; index < points.length - 1; index++) {
      const segmentLength = distance(points[index]!, points[index + 1]!);
      const segmentWidth =
        index === points.length - 2 ? Math.min(width, endWidth) : width;
      conservativeDeficitArea +=
        segmentLength * Math.max(0, nominalWidth - segmentWidth);
      if (width >= nominalWidth - WIDTH_EPSILON) nominalLength += segmentLength;
      if (segmentWidth >= nominalWidth - WIDTH_EPSILON) {
        conservativeNominalLength += segmentLength;
      }
    }
    return {
      length,
      deficitArea: length * Math.max(0, nominalWidth - width),
      conservativeDeficitArea,
      nominalLength,
      conservativeNominalLength,
      nonOctilinearSegmentCount: countNonOctilinearSegments(points),
      pointCount: points.length,
    };
  }

  private preservesCoverage(after: RouteQuality, before: RouteQuality) {
    const beforeCoverage =
      before.length <= WIDTH_EPSILON ? 1 : before.nominalLength / before.length;
    const afterCoverage =
      after.length <= WIDTH_EPSILON ? 1 : after.nominalLength / after.length;
    const beforeConservativeCoverage =
      before.length <= WIDTH_EPSILON
        ? 1
        : before.conservativeNominalLength / before.length;
    const afterConservativeCoverage =
      after.length <= WIDTH_EPSILON
        ? 1
        : after.conservativeNominalLength / after.length;
    if (
      afterCoverage + WIDTH_EPSILON < beforeCoverage ||
      afterConservativeCoverage + WIDTH_EPSILON < beforeConservativeCoverage
    ) {
      return false;
    }
    return !(
      after.length > before.length + WIDTH_EPSILON &&
      afterCoverage < 1 - WIDTH_EPSILON
    );
  }

  private advanceTrace() {
    this.traceCursor++;
    this.routeCursor = 0;
    this.rebuildObstacleIndex();
  }

  private createObstacleIndex() {
    return new SpatialObstacleIndex(
      this.inputProblem.simpleRouteJson,
      this.traces,
      this.traceIndices?.[this.traceCursor],
      [],
      this.connectionNameResolver,
    );
  }

  private rebuildObstacleIndex() {
    this.obstacleIndex = this.createObstacleIndex();
  }

  private resolveNominalTraceWidth(trace: SimplifiedPcbTrace) {
    const connection = this.findConnectionForTrace(trace);
    return Math.max(
      connection?.nominalTraceWidth ??
        connection?.width ??
        this.inputProblem.simpleRouteJson.nominalTraceWidth ??
        this.inputProblem.simpleRouteJson.minTraceWidth,
      this.inputProblem.simpleRouteJson.minTraceWidth,
    );
  }

  private findConnectionForTrace(trace: SimplifiedPcbTrace) {
    const traceNames = new Set(
      this.connectionNameResolver.canonicalize(
        this.getTraceConnectionNames(trace),
      ),
    );
    return this.inputProblem.simpleRouteJson.connections.find((connection) =>
      this.connectionNameResolver
        .canonicalize(this.getConnectionNames(connection))
        .some((name) => traceNames.has(name)),
    );
  }

  private getConnectionNames(connection: SimpleRouteConnection) {
    return [
      connection.name,
      connection.source_trace_id,
      connection.rootConnectionName,
      ...(connection.mergedConnectionNames ?? []),
    ].filter((name): name is string => Boolean(name));
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
    const candidate = this.candidates[this.candidateCursor];
    return {
      phase: this.phase,
      traceCursor: this.traceCursor,
      traceCount: this.traceIndices.length,
      traceIndex: this.traceIndices[this.traceCursor],
      routeCursor: this.routeCursor,
      candidateCursor: this.candidateCursor,
      candidateCount: this.candidates.length,
      candidateKind: candidate?.kind,
      candidateWidth: candidate?.width,
      candidatePointCount: candidate?.points.length,
      clearancePadding: this.clearancePaddingTiers[this.clearanceTierCursor],
      candidateShoveCount: this.candidateShoveCount,
      attemptedCandidateCount: this.attemptedCandidateCount,
      attemptedClearanceShoveCount: this.attemptedClearanceShoveCount,
      attemptedViaGridCount: this.attemptedViaGridCount,
      committedClearanceShoveCount: this.committedClearanceShoveCount,
      viaPairCountRemoved: this.viaPairCountRemoved,
      viaCountRemoved: this.viaCountRemoved,
      simplifiedPathCount: this.simplifiedPathCount,
      normalizedSegmentCount: this.normalizedSegmentCount,
      achievedExtraClearanceCount: this.achievedExtraClearanceCount,
      spatialIndexRectCount: this.obstacleIndex.items.length,
    };
  }

  computeProgress() {
    if (this.traceIndices.length === 0) return 1;
    const phaseOffset = this.resumePhase === "scan-via-pairs" ? 0 : 0.5;
    return Math.min(
      0.99,
      phaseOffset + (this.traceCursor / this.traceIndices.length) * 0.5,
    );
  }

  override getConstructorParams() {
    return [this.inputProblem];
  }

  override getOutput(): PowerTraceCleanupOutput {
    return this.traces;
  }

  override visualize(): GraphicsObject {
    const lines: NonNullable<GraphicsObject["lines"]> = [];
    const circles: NonNullable<GraphicsObject["circles"]> = [];
    const candidate = this.candidates[this.candidateCursor];
    for (let traceIndex = 0; traceIndex < this.traces.length; traceIndex++) {
      const trace = this.traces[traceIndex]!;
      for (const point of trace.route) {
        if (point.route_type !== "via") continue;
        circles.push({
          center: point,
          radius: (point.via_diameter ?? 0.6) / 2,
          fill: "#d4a017",
          stroke: "#7a5700",
        });
      }
      for (let index = 0; index < trace.route.length - 1; index++) {
        const start = trace.route[index];
        const end = trace.route[index + 1];
        if (!isWire(start) || !isWire(end) || start.layer !== end.layer)
          continue;
        lines.push({
          points: [start, end],
          strokeColor: start.layer === "bottom" ? "#376fc4" : "#777",
          strokeWidth: start.width,
        });
      }
    }
    if (candidate) {
      for (let index = 0; index < candidate.points.length - 1; index++) {
        lines.push({
          points: [candidate.points[index]!, candidate.points[index + 1]!],
          strokeColor: "#ff7400",
          strokeWidth:
            candidate.width +
            (this.clearancePaddingTiers[this.clearanceTierCursor] ?? 0) * 2,
        });
      }
    }
    return {
      coordinateSystem: "cartesian",
      title: `Power trace cleanup: ${this.phase}`,
      lines,
      points: [],
      circles,
      rects: [],
      texts: [],
    };
  }
}
