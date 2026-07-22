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
  ViaRoutePoint,
  WireRoutePoint,
} from "./types";

type CleanupPhase =
  | "repair-vias"
  | "scan-via-pairs"
  | "scan-pad-clearance"
  | "scan-simplification"
  | "evaluate-candidate"
  | "shove-clearance"
  | "route-via-pair"
  | "complete";

type CleanupKind = "via-pair" | "pad-clearance" | "simplification";

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
  padClearance: number;
  originalQuality: RouteQuality;
};

type ViaGridAttempt = {
  kind: CleanupKind;
  traceIndex: number;
  startIndex: number;
  endIndex: number;
  layer: string;
  padClearance: number;
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

const isVia = (
  point: SimplifiedPcbTrace["route"][number] | undefined,
): point is ViaRoutePoint => point?.route_type === "via";

const VIA_REPAIR_DIRECTIONS = Array.from({ length: 24 }, (_, index) => {
  const angle = (index * Math.PI) / 12;
  return { x: Math.cos(angle), y: Math.sin(angle) };
});

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
  phase: CleanupPhase = "repair-vias";

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
  relocatedViaCount = 0;
  unresolvedViaCount = 0;
  padClearanceRerouteCount = 0;
  unresolvedPadClearanceCount = 0;
  initialPadClearanceViolationCount = 0;
  remainingPadClearanceViolationCount = 0;

  private readonly connectionNameResolver: ConnectionNameResolver;
  private readonly traceIndices: number[];
  private readonly maxRerouteLength: number;
  private readonly clearancePaddingTiers: number[];
  private readonly desiredPadClearance: number;
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
    this.desiredPadClearance = Math.max(
      inputProblem.desiredPadClearance ?? 0.2,
      inputProblem.simpleRouteJson.minTraceToPadEdgeClearance ?? 0,
      0.1,
    );
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
    this.initialPadClearanceViolationCount = this.countPadClearanceViolations();
    this.remainingPadClearanceViolationCount =
      this.initialPadClearanceViolationCount;
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
      case "repair-vias":
        this.repairNextVia();
        break;
      case "scan-via-pairs":
        this.scanNextViaPair();
        break;
      case "scan-pad-clearance":
        this.scanNextPadClearance();
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

  private repairNextVia() {
    const trace = this.traces[this.traceCursor];
    if (!trace) {
      this.traceCursor = 0;
      this.routeCursor = 0;
      this.phase = "scan-via-pairs";
      this.rebuildObstacleIndex();
      return;
    }
    const viaIndex = trace.route.findIndex(
      (point, index) => index >= this.routeCursor && isVia(point),
    );
    if (viaIndex === -1) {
      this.traceCursor++;
      this.routeCursor = 0;
      return;
    }
    this.routeCursor = viaIndex + 1;
    const via = trace.route[viaIndex];
    const leftWire = trace.route[viaIndex - 1];
    const rightWire = trace.route[viaIndex + 1];
    if (!isVia(via) || !isWire(leftWire) || !isWire(rightWire)) return;

    const connectionNames = this.getTraceConnectionNames(trace);
    // Via repair is a DFM pass, not a power-clearance pass: vias must clear
    // unrelated copper by the board minimum and must never overlap connected
    // pads. Applying the larger power-to-pad target to the via annulus creates
    // unnecessarily long necks in otherwise healthy power routes.
    const padClearance = this.getBaseObstacleClearance();
    if (
      !this.obstacleIndex.collidesVia({
        point: via,
        layers: this.obstacleIndex.boardLayers,
        padDiameter: via.via_diameter ?? 0.6,
        holeDiameter:
          via.via_hole_diameter ?? this.obstacleIndex.defaultViaHoleDiameter,
        connectionNames,
        ignoreTraceIndex: this.traceCursor,
        ignoreRouteRange: { start: viaIndex, end: viaIndex },
        obstacleClearance: padClearance,
        blockSameNetObstacles: true,
        sameNetObstacleClearance: 0,
      })
    ) {
      return;
    }

    const replacement = this.findViaRepair(trace, viaIndex, padClearance);
    if (!replacement) {
      this.unresolvedViaCount++;
      return;
    }
    trace.route.splice(
      replacement.startIndex,
      replacement.endIndex - replacement.startIndex + 1,
      ...replacement.route,
    );
    this.relocatedViaCount++;
    this.routeCursor = replacement.startIndex + replacement.route.length;
    this.rebuildObstacleIndex();
  }

  private findViaRepair(
    trace: SimplifiedPcbTrace,
    viaIndex: number,
    padClearance: number,
  ) {
    const via = trace.route[viaIndex];
    const leftWire = trace.route[viaIndex - 1];
    const rightWire = trace.route[viaIndex + 1];
    if (!isVia(via) || !isWire(leftWire) || !isWire(rightWire)) return null;

    const leftIsEndpoint =
      viaIndex - 1 === 0 || !isWire(trace.route[viaIndex - 2]);
    const rightIsEndpoint =
      viaIndex + 1 === trace.route.length - 1 ||
      !isWire(trace.route[viaIndex + 2]);
    const leftAnchor = leftIsEndpoint
      ? leftWire
      : (trace.route[viaIndex - 2] as WireRoutePoint);
    const rightAnchor = rightIsEndpoint
      ? rightWire
      : (trace.route[viaIndex + 2] as WireRoutePoint);
    const originalLength =
      distance(leftAnchor, via) + distance(via, rightAnchor);
    const connectionNames = this.getTraceConnectionNames(trace);
    const viaDiameter = via.via_diameter ?? 0.6;
    const holeDiameter =
      via.via_hole_diameter ?? this.obstacleIndex.defaultViaHoleDiameter;
    const minimumRadius = Math.max(
      0.3,
      holeDiameter +
        this.obstacleIndex.minViaHoleEdgeToViaHoleEdgeClearance +
        0.05,
    );
    const candidates = [
      minimumRadius,
      minimumRadius + 0.15,
      minimumRadius + 0.3,
      minimumRadius + 0.5,
      minimumRadius + 0.75,
      minimumRadius + 1,
      minimumRadius + 1.5,
      minimumRadius + 2,
    ].flatMap((radius) =>
      VIA_REPAIR_DIRECTIONS.map((direction) => ({
        x: Math.round((via.x + direction.x * radius) / 0.025) * 0.025,
        y: Math.round((via.y + direction.y * radius) / 0.025) * 0.025,
      })),
    );

    const safeCandidates = candidates.flatMap((point) => {
      const movedLength =
        distance(leftAnchor, point) + distance(point, rightAnchor);
      if (movedLength > originalLength + 3 + WIDTH_EPSILON) return [];
      if (
        this.obstacleIndex.collidesVia({
          point,
          layers: this.obstacleIndex.boardLayers,
          padDiameter: viaDiameter,
          holeDiameter,
          connectionNames,
          ignoreTraceIndex: this.traceCursor,
          ignoreRouteRange: { start: viaIndex, end: viaIndex },
          obstacleClearance: padClearance,
          blockSameNetObstacles: true,
          sameNetObstacleClearance: 0,
        })
      ) {
        return [];
      }
      const ignoreRouteRange = {
        start: Math.max(0, viaIndex - 2),
        end: Math.min(trace.route.length - 1, viaIndex + 2),
      };
      const segmentChecks = [
        {
          start: leftAnchor,
          end: point,
          layer: leftWire.layer,
          width: leftWire.width,
        },
        {
          start: point,
          end: rightAnchor,
          layer: rightWire.layer,
          width: rightWire.width,
        },
      ];
      if (
        segmentChecks.some((segment) =>
          this.obstacleIndex.collides({
            ...segment,
            connectionNames,
            ignoreTraceIndex: this.traceCursor,
            ignoreRouteRange,
            obstacleClearance: padClearance,
          }),
        )
      ) {
        return [];
      }
      return [{ point, movedLength }];
    });
    safeCandidates.sort(
      (a, b) =>
        a.movedLength - b.movedLength ||
        distance(a.point, via) - distance(b.point, via),
    );
    const best = safeCandidates[0];
    if (!best) return null;

    const movedLeft: WireRoutePoint = { ...leftWire, ...best.point };
    const movedVia: ViaRoutePoint = { ...via, ...best.point };
    const movedRight: WireRoutePoint = { ...rightWire, ...best.point };
    return {
      startIndex: viaIndex - 1,
      endIndex: viaIndex + 1,
      route: [
        ...(leftIsEndpoint ? [leftWire] : []),
        movedLeft,
        movedVia,
        movedRight,
        ...(rightIsEndpoint ? [rightWire] : []),
      ],
    };
  }

  private scanNextViaPair() {
    const traceIndex = this.traceIndices[this.traceCursor];
    if (traceIndex === undefined) {
      this.traceCursor = 0;
      this.routeCursor = 0;
      this.phase = "scan-pad-clearance";
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

  private scanNextPadClearance() {
    const traceIndex = this.traceIndices[this.traceCursor];
    if (traceIndex === undefined) {
      this.traceCursor = 0;
      this.routeCursor = 0;
      this.phase = "scan-simplification";
      return;
    }
    const trace = this.traces[traceIndex]!;
    if (this.resolveNominalTraceWidth(trace) < 0.5 - WIDTH_EPSILON) {
      this.advanceTrace();
      return;
    }
    const segmentIndex = this.routeCursor;
    const start = trace.route[segmentIndex];
    const end = trace.route[segmentIndex + 1];
    if (!isWire(start) || !isWire(end) || start.layer !== end.layer) {
      if (segmentIndex >= trace.route.length - 1) this.advanceTrace();
      else this.routeCursor++;
      return;
    }
    this.routeCursor++;
    if (!this.segmentHasPadClearanceViolation(traceIndex, segmentIndex)) {
      return;
    }

    const intervals = this.getPadClearanceIntervals(trace, segmentIndex);
    const candidates = intervals.flatMap((interval) =>
      this.createCandidates({
        kind: "pad-clearance",
        traceIndex,
        startIndex: interval.startIndex,
        endIndex: interval.endIndex,
      }),
    );
    if (candidates.length === 0) {
      this.unresolvedPadClearanceCount++;
      return;
    }
    this.beginCandidates(candidates.slice(0, 48), "scan-pad-clearance", true);
  }

  private segmentHasPadClearanceViolation(
    traceIndex: number,
    segmentIndex: number,
  ) {
    const trace = this.traces[traceIndex]!;
    const start = trace.route[segmentIndex];
    const end = trace.route[segmentIndex + 1];
    if (!isWire(start) || !isWire(end) || start.layer !== end.layer) {
      return false;
    }
    return this.obstacleIndex
      .findCollisions({
        start,
        end,
        layer: start.layer,
        width: Math.max(start.width, end.width),
        connectionNames: this.getTraceConnectionNames(trace),
        ignoreTraceIndex: traceIndex,
        ignoreRouteRange: {
          start: Math.max(0, segmentIndex - 1),
          end: Math.min(trace.route.length - 1, segmentIndex + 2),
        },
        obstacleClearance: this.getPadClearanceForTrace(trace),
      })
      .some((item) => item.kind === "obstacle" && item.obstacleKind === "pad");
  }

  private getPadClearanceIntervals(
    trace: SimplifiedPcbTrace,
    segmentIndex: number,
  ) {
    const segmentStart = trace.route[segmentIndex];
    if (!isWire(segmentStart)) return [];
    const startIndices = [segmentIndex];
    let accumulated = 0;
    for (let index = segmentIndex - 1; index >= 0; index--) {
      const start = trace.route[index];
      const end = trace.route[index + 1];
      if (
        !isWire(start) ||
        !isWire(end) ||
        start.layer !== segmentStart.layer ||
        end.layer !== segmentStart.layer
      ) {
        break;
      }
      accumulated += distance(start, end);
      if (accumulated > this.maxRerouteLength / 2 + WIDTH_EPSILON) break;
      startIndices.push(index);
    }

    const endIndices = [segmentIndex + 1];
    accumulated = 0;
    for (
      let index = segmentIndex + 1;
      index < trace.route.length - 1;
      index++
    ) {
      const start = trace.route[index];
      const end = trace.route[index + 1];
      if (
        !isWire(start) ||
        !isWire(end) ||
        start.layer !== segmentStart.layer ||
        end.layer !== segmentStart.layer
      ) {
        break;
      }
      accumulated += distance(start, end);
      if (accumulated > this.maxRerouteLength / 2 + WIDTH_EPSILON) break;
      endIndices.push(index + 1);
    }

    return startIndices
      .flatMap((startIndex) =>
        endIndices.map((endIndex) => ({
          startIndex,
          endIndex,
          length: this.measureRouteRange(trace, startIndex, endIndex).length,
        })),
      )
      .filter(
        (interval) =>
          interval.length <= this.maxRerouteLength + WIDTH_EPSILON &&
          interval.startIndex < interval.endIndex,
      )
      .sort((a, b) => b.length - a.length)
      .slice(0, 8);
  }

  private scanNextSimplification() {
    const traceIndex = this.traceIndices[this.traceCursor];
    if (traceIndex === undefined) {
      this.remainingPadClearanceViolationCount =
        this.countPadClearanceViolations();
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
    const padClearance = this.getCandidatePadClearance(
      kind,
      traceIndex,
      startIndex,
      endIndex,
    );
    const candidates: CleanupCandidate[] = [];
    const pointCandidates = calculateOctilinearPaths(start, end);
    if (
      kind === "pad-clearance" &&
      countNonOctilinearSegments([start, end]) === 0
    ) {
      const segmentLength = distance(start, end);
      if (segmentLength > WIDTH_EPSILON) {
        const normal = {
          x: -(end.y - start.y) / segmentLength,
          y: (end.x - start.x) / segmentLength,
        };
        for (const offset of [0.25, 0.5, 0.75, 1, 1.5, 2]) {
          for (const direction of [-1, 1]) {
            pointCandidates.push([
              start,
              {
                x: start.x + normal.x * offset * direction,
                y: start.y + normal.y * offset * direction,
              },
              {
                x: end.x + normal.x * offset * direction,
                y: end.y + normal.y * offset * direction,
              },
              end,
            ]);
          }
        }
      }
    }

    const uniquePointCandidates = new Map(
      pointCandidates.map((points) => [
        points
          .map((point) => `${point.x.toFixed(6)},${point.y.toFixed(6)}`)
          .join(";"),
        points,
      ]),
    );
    for (const points of uniquePointCandidates.values()) {
      const pathLength = getPathLength(points);
      if (
        pathLength > this.maxRerouteLength + WIDTH_EPSILON ||
        (kind === "pad-clearance" &&
          pathLength > originalQuality.length * 1.35 + 0.5) ||
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
          start.width,
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
          padClearance,
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
          obstacleClearance: candidate.padClearance,
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
        obstacleClearance: candidate.padClearance,
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
    const startWidth =
      segmentIndex === 0 && isWire(originalStart)
        ? originalStart.width
        : candidate.width;
    const endWidth =
      segmentIndex === candidate.points.length - 2 && isWire(originalEnd)
        ? originalEnd.width
        : candidate.width;
    // Core may reverse a route while associating it with its source trace.
    // Validate the larger endpoint width so clearance is independent of that
    // serialization direction.
    return Math.max(startWidth, endWidth);
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
          index === 0
            ? originalStart.width
            : index === candidate.points.length - 1
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
    } else if (candidate.kind === "pad-clearance") {
      this.padClearanceRerouteCount++;
      this.routeCursor =
        candidate.startIndex + Math.max(1, replacement.length - 1);
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
        .filter((candidate) => candidate.kind === gridFallbackCandidate?.kind)
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
      gridFallbackCandidate
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
      kind: candidate.kind,
      traceIndex: candidate.traceIndex,
      startIndex: candidate.startIndex,
      endIndex: candidate.endIndex,
      layer: candidate.layer,
      padClearance: candidate.padClearance,
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
      this.phase = this.resumePhase;
      return;
    }
    if (attempt.widthCursor >= attempt.widths.length) {
      if (attempt.kind === "pad-clearance") {
        this.unresolvedPadClearanceCount++;
      }
      this.viaGridAttempt = null;
      this.routeCursor++;
      this.phase = this.resumePhase;
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
      this.phase = this.resumePhase;
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
      obstacleClearance: attempt.padClearance,
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
          (trace.route[attempt.startIndex] as WireRoutePoint).width,
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
            kind: attempt.kind,
            traceIndex: attempt.traceIndex,
            startIndex: attempt.startIndex,
            endIndex: attempt.endIndex,
            layer: attempt.layer,
            points: output.points,
            width: output.traceWidth,
            padClearance: attempt.padClearance,
            originalQuality: attempt.originalQuality,
          };
          this.viaGridAttempt = null;
          this.beginCandidates([candidate], this.resumePhase, false);
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
    startWidth = width,
  ): RouteQuality {
    const length = getPathLength(points);
    let deficitArea = 0;
    let conservativeDeficitArea = 0;
    let nominalLength = 0;
    let conservativeNominalLength = 0;
    for (let index = 0; index < points.length - 1; index++) {
      const segmentLength = distance(points[index]!, points[index + 1]!);
      const segmentStartWidth = index === 0 ? startWidth : width;
      const segmentEndWidth = index === points.length - 2 ? endWidth : width;
      const segmentWidth = Math.min(segmentStartWidth, segmentEndWidth);
      deficitArea +=
        segmentLength * Math.max(0, nominalWidth - segmentStartWidth);
      conservativeDeficitArea +=
        segmentLength * Math.max(0, nominalWidth - segmentWidth);
      if (segmentStartWidth >= nominalWidth - WIDTH_EPSILON) {
        nominalLength += segmentLength;
      }
      if (segmentWidth >= nominalWidth - WIDTH_EPSILON) {
        conservativeNominalLength += segmentLength;
      }
    }
    return {
      length,
      deficitArea,
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
      this.phase === "repair-vias"
        ? undefined
        : this.traceIndices?.[this.traceCursor],
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

  private getPadClearanceForTrace(trace: SimplifiedPcbTrace) {
    const baseClearance = this.getBaseObstacleClearance();
    return this.resolveNominalTraceWidth(trace) >= 0.5 - WIDTH_EPSILON
      ? Math.max(baseClearance, this.desiredPadClearance)
      : baseClearance;
  }

  private getBaseObstacleClearance() {
    return Math.max(
      this.inputProblem.simpleRouteJson.defaultObstacleMargin ?? 0,
      this.inputProblem.simpleRouteJson.minTraceToPadEdgeClearance ?? 0,
      0.1,
    );
  }

  private getCandidatePadClearance(
    kind: CleanupKind,
    traceIndex: number,
    startIndex: number,
    endIndex: number,
  ) {
    const trace = this.traces[traceIndex]!;
    const baseClearance = this.getBaseObstacleClearance();
    const targetClearance = this.getPadClearanceForTrace(trace);
    if (kind === "pad-clearance") return targetClearance;

    // Do not trade away clearance that a route already has. For unavoidable
    // package escapes, preserve the current 0.01 mm tier instead of requiring
    // the global target and disabling useful via removal/path simplification.
    const tierCount = Math.ceil((targetClearance - baseClearance) / 0.01);
    for (let tierIndex = 0; tierIndex <= tierCount; tierIndex++) {
      const clearance = Number((targetClearance - tierIndex * 0.01).toFixed(6));
      if (clearance < baseClearance - WIDTH_EPSILON) break;
      if (
        !this.routeRangeHasPadClearanceViolation(
          traceIndex,
          startIndex,
          endIndex,
          clearance,
        )
      ) {
        return clearance;
      }
    }
    return baseClearance;
  }

  private routeRangeHasPadClearanceViolation(
    traceIndex: number,
    startIndex: number,
    endIndex: number,
    clearance: number,
  ) {
    const trace = this.traces[traceIndex]!;
    const connectionNames = this.getTraceConnectionNames(trace);
    for (let routeIndex = startIndex; routeIndex < endIndex; routeIndex++) {
      const start = trace.route[routeIndex];
      const end = trace.route[routeIndex + 1];
      if (!isWire(start) || !isWire(end) || start.layer !== end.layer) {
        continue;
      }
      const collisions = this.obstacleIndex.findCollisions({
        start,
        end,
        layer: start.layer,
        width: Math.max(start.width, end.width),
        connectionNames,
        ignoreTraceIndex: traceIndex,
        ignoreRouteRange: {
          start: Math.max(0, startIndex - 1),
          end: Math.min(trace.route.length - 1, endIndex + 1),
        },
        obstacleClearance: clearance,
      });
      if (
        collisions.some(
          (item) => item.kind === "obstacle" && item.obstacleKind === "pad",
        )
      ) {
        return true;
      }
    }
    return false;
  }

  private countPadClearanceViolations() {
    let violationCount = 0;
    for (const traceIndex of this.traceIndices) {
      const trace = this.traces[traceIndex];
      if (!trace) continue;
      const connectionNames = this.getTraceConnectionNames(trace);
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
        const collisions = this.obstacleIndex.findCollisions({
          start,
          end,
          layer: start.layer,
          width: Math.max(start.width, end.width),
          connectionNames,
          ignoreTraceIndex: traceIndex,
          ignoreRouteRange: {
            start: Math.max(0, routeIndex - 1),
            end: Math.min(trace.route.length - 1, routeIndex + 2),
          },
          obstacleClearance: this.getPadClearanceForTrace(trace),
        });
        if (
          collisions.some(
            (item) => item.kind === "obstacle" && item.obstacleKind === "pad",
          )
        ) {
          violationCount++;
        }
      }
    }
    return violationCount;
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
      relocatedViaCount: this.relocatedViaCount,
      unresolvedViaCount: this.unresolvedViaCount,
      padClearanceRerouteCount: this.padClearanceRerouteCount,
      unresolvedPadClearanceCount: this.unresolvedPadClearanceCount,
      initialPadClearanceViolationCount: this.initialPadClearanceViolationCount,
      remainingPadClearanceViolationCount:
        this.remainingPadClearanceViolationCount,
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
