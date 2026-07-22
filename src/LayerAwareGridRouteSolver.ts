import { BaseSolver } from "@tscircuit/solver-utils";
import type { GraphicsObject } from "graphics-debug";
import { clamp, distance, pointsEqual } from "./geometry";
import type {
  CopperRoutePoint,
  LayerGridRouteOutput,
  LayerGridRouteProblem,
  Point,
  WireRoutePoint,
} from "./types";

type SearchNode = {
  row: number;
  column: number;
  x: number;
  y: number;
  layerIndex: number;
  viaCount: number;
  viaPoints: Point[];
  g: number;
  f: number;
  parentIndex: number;
};

class MinHeap {
  private nodeIndices: number[] = [];
  private priorities: number[] = [];

  get size() {
    return this.nodeIndices.length;
  }

  push(nodeIndex: number, priority: number) {
    let index = this.nodeIndices.length;
    this.nodeIndices.push(nodeIndex);
    this.priorities.push(priority);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.priorities[parent]! <= priority) break;
      this.swap(index, parent);
      index = parent;
    }
  }

  pop() {
    const result = this.nodeIndices[0]!;
    const lastNode = this.nodeIndices.pop()!;
    const lastPriority = this.priorities.pop()!;
    if (this.nodeIndices.length === 0) return result;
    this.nodeIndices[0] = lastNode;
    this.priorities[0] = lastPriority;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      if (left >= this.nodeIndices.length) break;
      let smallest = left;
      if (
        right < this.nodeIndices.length &&
        this.priorities[right]! < this.priorities[left]!
      ) {
        smallest = right;
      }
      if (this.priorities[index]! <= this.priorities[smallest]!) break;
      this.swap(index, smallest);
      index = smallest;
    }
    return result;
  }

  private swap(a: number, b: number) {
    [this.nodeIndices[a], this.nodeIndices[b]] = [
      this.nodeIndices[b]!,
      this.nodeIndices[a]!,
    ];
    [this.priorities[a], this.priorities[b]] = [
      this.priorities[b]!,
      this.priorities[a]!,
    ];
  }
}

const DIRECTIONS = [
  [-1, -1],
  [-1, 0],
  [-1, 1],
  [0, -1],
  [0, 1],
  [1, -1],
  [1, 0],
  [1, 1],
] as const;

const LAYER_COLORS = ["#d53535", "#3478c8", "#8e44ad", "#15956f"];

/**
 * A bounded multilayer A* used only for power routes that remain necked after
 * local widening. Planar moves and via moves are each exposed as individual
 * BaseSolver steps, which keeps the search inspectable in the generic solver
 * debugger.
 */
export class LayerAwareGridRouteSolver extends BaseSolver {
  readonly problem: LayerGridRouteProblem;
  readonly searchBounds: LayerGridRouteProblem["bounds"];
  readonly rows: number;
  readonly columns: number;
  readonly origin: Point;

  private readonly nodes: SearchNode[] = [];
  private readonly open = new MinHeap();
  private readonly bestCost = new Map<number, number>();
  private readonly closed = new Set<number>();
  private readonly baseStateCount: number;
  private readonly stateSpaceUpperBound: number;
  private readonly endLayerIndices: Set<number>;
  private readonly targetCell: { row: number; column: number };
  private readonly segmentWidthCache = new Map<string, number>();
  private closedStateCount = 0;
  private output: LayerGridRouteOutput | null = null;

  constructor(problem: LayerGridRouteProblem) {
    super();
    this.problem = problem;
    const radius =
      Math.max(problem.traceWidth, problem.viaDiameter) / 2 +
      problem.obstacleIndex.clearance;
    const minX = clamp(
      Math.min(problem.start.x, problem.end.x) - problem.searchPadding,
      problem.bounds.minX + radius,
      problem.bounds.maxX - radius,
    );
    const maxX = clamp(
      Math.max(problem.start.x, problem.end.x) + problem.searchPadding,
      problem.bounds.minX + radius,
      problem.bounds.maxX - radius,
    );
    const minY = clamp(
      Math.min(problem.start.y, problem.end.y) - problem.searchPadding,
      problem.bounds.minY + radius,
      problem.bounds.maxY - radius,
    );
    const maxY = clamp(
      Math.max(problem.start.y, problem.end.y) + problem.searchPadding,
      problem.bounds.minY + radius,
      problem.bounds.maxY - radius,
    );
    const alignedMinX =
      Math.floor((minX - problem.gridOffset.x) / problem.gridSize) *
        problem.gridSize +
      problem.gridOffset.x;
    const alignedMinY =
      Math.floor((minY - problem.gridOffset.y) / problem.gridSize) *
        problem.gridSize +
      problem.gridOffset.y;
    this.origin = { x: alignedMinX, y: alignedMinY };
    this.columns = Math.max(
      2,
      Math.floor((maxX - alignedMinX) / problem.gridSize) + 1,
    );
    this.rows = Math.max(
      2,
      Math.floor((maxY - alignedMinY) / problem.gridSize) + 1,
    );
    this.searchBounds = {
      minX: alignedMinX,
      minY: alignedMinY,
      maxX: alignedMinX + (this.columns - 1) * problem.gridSize,
      maxY: alignedMinY + (this.rows - 1) * problem.gridSize,
    };
    const stateCount =
      this.rows *
      this.columns *
      problem.layers.length *
      (problem.maxViaCount + 1);
    this.baseStateCount = stateCount;
    // The first via position changes where a second via may legally land.
    // Include it in dominance without allocating the sparse Cartesian product.
    this.stateSpaceUpperBound = stateCount * (this.rows * this.columns + 1);
    this.targetCell = this.pointToCell(problem.end);
    this.endLayerIndices = new Set(
      problem.endLayers
        .map((layer) => problem.layers.indexOf(layer))
        .filter((index) => index >= 0),
    );

    const startCell = this.pointToCell(problem.start);
    for (const startLayer of problem.startLayers) {
      const layerIndex = problem.layers.indexOf(startLayer);
      if (layerIndex < 0 || this.endpointCollides(problem.start, layerIndex)) {
        continue;
      }
      const node: SearchNode = {
        ...startCell,
        ...problem.start,
        layerIndex,
        viaCount: 0,
        viaPoints: [],
        g: 0,
        f: this.heuristic(problem.start),
        parentIndex: -1,
      };
      const nodeIndex = this.nodes.length;
      this.nodes.push(node);
      this.open.push(nodeIndex, node.f);
      this.bestCost.set(this.toStateIndex(node), 0);
    }

    if (this.open.size === 0 || this.endLayerIndices.size === 0) {
      this.failed = true;
      this.error = "No collision-free multilayer route endpoint";
    }
    this.MAX_ITERATIONS = Math.min(15_000, Math.max(2_000, stateCount * 2));
    this.stats = this.createStats();
  }

  override getSolverName() {
    return `LayerAwareGridRouteSolver(${this.problem.gridSize.toFixed(3)}mm)`;
  }

  override _step() {
    if (this.open.size === 0) {
      this.failed = true;
      this.error = "No collision-free multilayer grid route found";
      return;
    }

    const nodeIndex = this.open.pop();
    const node = this.nodes[nodeIndex]!;
    const stateIndex = this.toStateIndex(node);
    if (this.closed.has(stateIndex)) return;
    this.closed.add(stateIndex);
    this.closedStateCount++;

    if (
      node.row === this.targetCell.row &&
      node.column === this.targetCell.column &&
      this.endLayerIndices.has(node.layerIndex) &&
      node.viaCount >= this.problem.minViaCount &&
      !this.segmentCollides(node, this.problem.end)
    ) {
      this.output = this.reconstructRoute(nodeIndex);
      this.solved = true;
      this.stats = this.createStats();
      return;
    }

    this.expandPlanarMoves(nodeIndex, node);
    this.expandViaMoves(nodeIndex, node);
    this.stats = this.createStats();
  }

  private expandPlanarMoves(nodeIndex: number, node: SearchNode) {
    for (const [deltaRow, deltaColumn] of DIRECTIONS) {
      const row = node.row + deltaRow;
      const column = node.column + deltaColumn;
      if (row < 0 || row >= this.rows || column < 0 || column >= this.columns)
        continue;
      const point = this.cellToPoint(row, column);
      const segmentWidth = this.getSafeSegmentWidth(node, point);
      if (segmentWidth <= 0) continue;
      const geometricMoveCost =
        this.problem.gridSize *
        (deltaRow !== 0 && deltaColumn !== 0 ? Math.SQRT2 : 1);
      // Narrow copper is allowed for pad escape, but it is electrically more
      // expensive. Squaring the width ratio makes A* spend only the neck
      // length it needs and prefer a longer nominal-width route on another
      // layer instead of taking a deceptively short, thin pad escape.
      const moveCost =
        geometricMoveCost *
        Math.max(
          1,
          (this.problem.traceWidth / segmentWidth) **
            this.problem.neckPenaltyExponent,
        );
      this.enqueueNode({
        row,
        column,
        ...point,
        layerIndex: node.layerIndex,
        viaCount: node.viaCount,
        viaPoints: node.viaPoints,
        g: node.g + moveCost,
        parentIndex: nodeIndex,
      });
    }
  }

  private expandViaMoves(nodeIndex: number, node: SearchNode) {
    if (node.viaCount >= this.problem.maxViaCount) return;
    const minimumEndpointEscape = this.problem.gridSize * 0.5;
    if (
      distance(node, this.problem.start) < minimumEndpointEscape - 1e-9 ||
      distance(node, this.problem.end) < minimumEndpointEscape - 1e-9
    ) {
      return;
    }
    const parent =
      node.parentIndex >= 0 ? this.nodes[node.parentIndex] : undefined;
    // A same-location layer reversal only burns two vias and can never improve
    // the path, so remove it from the search graph entirely.
    if (
      parent &&
      parent.layerIndex !== node.layerIndex &&
      pointsEqual(parent, node)
    ) {
      return;
    }

    for (
      let nextLayerIndex = 0;
      nextLayerIndex < this.problem.layers.length;
      nextLayerIndex++
    ) {
      if (nextLayerIndex === node.layerIndex) continue;
      if (
        this.problem.obstacleIndex.collidesVia({
          point: node,
          layers: this.problem.layers,
          padDiameter: this.problem.viaDiameter,
          holeDiameter: this.problem.viaHoleDiameter,
          connectionNames: this.problem.connectionNames,
          ignoreTraceIndex: this.problem.ignoreTraceIndex,
          ignoreTraceIndices: this.problem.softTraceIndices,
          ignoreRouteRange: this.problem.ignoreRouteRange,
          obstacleClearance: this.problem.obstacleClearance,
          blockSameNetObstacles: true,
          sameNetObstacleClearance: 0,
          otherNewViaPoints: node.viaPoints,
          fixedVias: this.problem.fixedVias,
        })
      ) {
        continue;
      }
      this.enqueueNode({
        row: node.row,
        column: node.column,
        x: node.x,
        y: node.y,
        layerIndex: nextLayerIndex,
        viaCount: node.viaCount + 1,
        viaPoints: [...node.viaPoints, { x: node.x, y: node.y }],
        g: node.g + this.problem.viaCost,
        parentIndex: nodeIndex,
      });
    }
  }

  private enqueueNode(node: Omit<SearchNode, "f">) {
    const stateIndex = this.toStateIndex(node);
    if (
      this.closed.has(stateIndex) ||
      node.g >= (this.bestCost.get(stateIndex) ?? Number.POSITIVE_INFINITY)
    ) {
      return;
    }
    this.bestCost.set(stateIndex, node.g);
    const f = node.g + this.heuristic(node);
    const nextNodeIndex = this.nodes.length;
    this.nodes.push({ ...node, f });
    this.open.push(nextNodeIndex, f);
  }

  private endpointCollides(point: Point, layerIndex: number) {
    return (
      this.getSafeSegmentWidth({ ...point, layerIndex, viaCount: 0 }, point) <=
      0
    );
  }

  private segmentCollides(
    start: Pick<SearchNode, "x" | "y" | "layerIndex" | "viaCount">,
    end: Point,
  ) {
    return this.getSafeSegmentWidth(start, end) <= 0;
  }

  private getSafeSegmentWidth(
    start: Pick<SearchNode, "x" | "y" | "layerIndex" | "viaCount">,
    end: Point,
  ) {
    const layer = this.problem.layers[start.layerIndex]!;
    const inStartNeck =
      this.problem.startLayers.length === 1 &&
      start.viaCount === 0 &&
      layer === this.problem.originalStartLayer &&
      distance(this.problem.start, start) <=
        this.problem.maxStartNeckLength + 1e-9 &&
      distance(this.problem.start, end) <=
        this.problem.maxStartNeckLength + 1e-9;
    const inEndNeck =
      this.problem.endLayers.length === 1 &&
      layer === this.problem.originalEndLayer &&
      distance(this.problem.end, start) <=
        this.problem.maxEndNeckLength + 1e-9 &&
      distance(this.problem.end, end) <= this.problem.maxEndNeckLength + 1e-9;
    const minimumWidth = Math.max(
      inStartNeck ? this.problem.startNeckWidth : 0,
      inEndNeck ? this.problem.endNeckWidth : 0,
    );
    const cacheKey = [
      start.x,
      start.y,
      end.x,
      end.y,
      start.layerIndex,
      start.viaCount,
      minimumWidth,
    ].join(":");
    const cachedWidth = this.segmentWidthCache.get(cacheKey);
    if (cachedWidth !== undefined) return cachedWidth;

    const isSafe = (width: number) =>
      !this.problem.obstacleIndex.collides({
        start,
        end,
        layer,
        width,
        connectionNames: this.problem.connectionNames,
        ignoreTraceIndex: this.problem.ignoreTraceIndex,
        ignoreTraceIndices: this.problem.softTraceIndices,
        ignoreRouteRange: this.problem.ignoreRouteRange,
        obstacleClearance: this.problem.obstacleClearance,
      });
    let safeWidth = 0;
    if (!inStartNeck && !inEndNeck) {
      safeWidth = isSafe(this.problem.traceWidth) ? this.problem.traceWidth : 0;
    } else {
      // Probe the full continuum at a fabrication-meaningful 0.025 mm
      // quantization. A monotonic binary search gives finer intermediate neck
      // widths than a small fixed fraction list without adding a hot-loop
      // performance bottleneck.
      const widthStep = 0.025;
      let low = Math.ceil((minimumWidth - 1e-9) / widthStep);
      let high = Math.floor((this.problem.traceWidth + 1e-9) / widthStep);
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const width = Number((middle * widthStep).toFixed(6));
        if (isSafe(width)) {
          safeWidth = width;
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }
      if (safeWidth < minimumWidth - 1e-9 && isSafe(minimumWidth)) {
        safeWidth = minimumWidth;
      }
    }
    this.segmentWidthCache.set(cacheKey, safeWidth);
    return safeWidth;
  }

  private reconstructRoute(goalNodeIndex: number): LayerGridRouteOutput {
    const path: SearchNode[] = [];
    let nodeIndex = goalNodeIndex;
    while (nodeIndex >= 0) {
      const node = this.nodes[nodeIndex]!;
      path.push(node);
      nodeIndex = node.parentIndex;
    }
    path.reverse();
    const goal = path[path.length - 1]!;
    if (!pointsEqual(goal, this.problem.end)) {
      path.push({
        ...goal,
        ...this.problem.end,
        row: this.targetCell.row,
        column: this.targetCell.column,
        parentIndex: -1,
      });
    }

    const sections: SearchNode[][] = [];
    let section: SearchNode[] = [path[0]!];
    for (let index = 1; index < path.length; index++) {
      const previous = path[index - 1]!;
      const current = path[index]!;
      if (current.layerIndex !== previous.layerIndex) {
        sections.push(section);
        section = [current];
      } else {
        section.push(current);
      }
    }
    sections.push(section);

    const route: CopperRoutePoint[] = [];
    for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex++) {
      const simplified = this.simplifySection(sections[sectionIndex]!);
      const edgeWidths = simplified
        .slice(0, -1)
        .map((point, index) =>
          this.getSafeSegmentWidth(point, simplified[index + 1]!),
        );
      const wirePoints: WireRoutePoint[] = simplified.map((point, index) => ({
        route_type: "wire",
        x: point.x,
        y: point.y,
        layer: this.problem.layers[point.layerIndex]!,
        // A vertex takes the smaller capacity of its incident segments. This
        // ensures max(endpoint widths) never exceeds either segment's tested
        // capacity and naturally creates a short, DRC-safe neck transition.
        width:
          edgeWidths.length === 0
            ? Math.min(this.problem.startNeckWidth, this.problem.endNeckWidth)
            : index === 0
              ? edgeWidths[0]!
              : index === simplified.length - 1
                ? edgeWidths[edgeWidths.length - 1]!
                : Math.min(edgeWidths[index - 1]!, edgeWidths[index]!),
      }));
      route.push(...wirePoints);

      const nextSection = sections[sectionIndex + 1];
      if (nextSection) {
        const fromLayer = this.problem.layers[simplified.at(-1)!.layerIndex]!;
        const toLayer = this.problem.layers[nextSection[0]!.layerIndex]!;
        const point = simplified.at(-1)!;
        route.push({
          route_type: "via",
          x: point.x,
          y: point.y,
          from_layer: fromLayer,
          to_layer: toLayer,
          via_diameter: this.problem.viaDiameter,
          via_hole_diameter: this.problem.viaHoleDiameter,
        });
      }
    }

    return {
      route,
      traceWidth: this.problem.traceWidth,
      startNeckWidth: this.problem.startNeckWidth,
      endNeckWidth: this.problem.endNeckWidth,
      gridSize: this.problem.gridSize,
      gridOffset: this.problem.gridOffset,
      viaCount: sections.length - 1,
    };
  }

  private simplifySection(points: SearchNode[]) {
    if (points.length <= 2) return points;
    if (this.problem.neckPenaltyExponent > 1) {
      return this.simplifyStrictSection(points);
    }
    return this.simplifyWidthPreservingSection(points);
  }

  private simplifyStrictSection(points: SearchNode[]) {
    const edgeWidths = points
      .slice(0, -1)
      .map((point, index) =>
        this.getSafeSegmentWidth(point, points[index + 1]!),
      );
    const electricalCostPrefix = [0];
    for (let index = 0; index < edgeWidths.length; index++) {
      electricalCostPrefix.push(
        electricalCostPrefix[index]! +
          this.getWidthPenalizedCost(
            points[index]!,
            points[index + 1]!,
            edgeWidths[index]!,
          ),
      );
    }
    const simplified = [points[0]!];
    let anchorIndex = 0;
    while (anchorIndex < points.length - 1) {
      let nextIndex = points.length - 1;
      while (
        nextIndex > anchorIndex + 1 &&
        !this.shortcutPreservesRouteQuality(
          points,
          edgeWidths,
          electricalCostPrefix,
          anchorIndex,
          nextIndex,
        )
      ) {
        nextIndex--;
      }
      simplified.push(points[nextIndex]!);
      anchorIndex = nextIndex;
    }
    return this.removeRedundantCollinearPoints(simplified);
  }

  private shortcutPreservesRouteQuality(
    points: SearchNode[],
    edgeWidths: number[],
    electricalCostPrefix: number[],
    startIndex: number,
    endIndex: number,
  ) {
    const width = this.getSafeSegmentWidth(
      points[startIndex]!,
      points[endIndex]!,
    );
    if (width <= 0) return false;
    let minimumOriginalWidth = Number.POSITIVE_INFINITY;
    for (let index = startIndex; index < endIndex; index++) {
      minimumOriginalWidth = Math.min(minimumOriginalWidth, edgeWidths[index]!);
    }
    const originalCost =
      electricalCostPrefix[endIndex]! - electricalCostPrefix[startIndex]!;
    return (
      width >= minimumOriginalWidth - 1e-9 &&
      this.getWidthPenalizedCost(
        points[startIndex]!,
        points[endIndex]!,
        width,
      ) <=
        originalCost + 1e-9
    );
  }

  private getWidthPenalizedCost(start: Point, end: Point, width: number) {
    return (
      distance(start, end) *
      Math.max(
        1,
        (this.problem.traceWidth / width) ** this.problem.neckPenaltyExponent,
      )
    );
  }

  private simplifyWidthPreservingSection(points: SearchNode[]) {
    const edgeWidths = points
      .slice(0, -1)
      .map((point, index) =>
        this.getSafeSegmentWidth(point, points[index + 1]!),
      );
    const electricalCostPrefix = [0];
    for (let index = 0; index < edgeWidths.length; index++) {
      electricalCostPrefix.push(
        electricalCostPrefix[index]! +
          distance(points[index]!, points[index + 1]!) *
            Math.max(
              1,
              (this.problem.traceWidth / edgeWidths[index]!) **
                this.problem.neckPenaltyExponent,
            ),
      );
    }

    const deficitByIndex = new Float64Array(points.length).fill(
      Number.POSITIVE_INFINITY,
    );
    const lengthByIndex = new Float64Array(points.length).fill(
      Number.POSITIVE_INFINITY,
    );
    const previousIndex = new Int32Array(points.length).fill(-1);
    deficitByIndex[0] = 0;
    lengthByIndex[0] = 0;

    for (let endIndex = 1; endIndex < points.length; endIndex++) {
      let minimumOriginalWidth = Number.POSITIVE_INFINITY;
      for (let startIndex = endIndex - 1; startIndex >= 0; startIndex--) {
        minimumOriginalWidth = Math.min(
          minimumOriginalWidth,
          edgeWidths[startIndex]!,
        );
        if (!Number.isFinite(deficitByIndex[startIndex]!)) continue;
        const width = this.getSafeSegmentWidth(
          points[startIndex]!,
          points[endIndex]!,
        );
        if (width < minimumOriginalWidth - 1e-9) continue;
        const segmentLength = distance(points[startIndex]!, points[endIndex]!);
        const electricalCost =
          segmentLength *
          Math.max(
            1,
            (this.problem.traceWidth / width) **
              this.problem.neckPenaltyExponent,
          );
        const originalElectricalCost =
          electricalCostPrefix[endIndex]! - electricalCostPrefix[startIndex]!;
        if (electricalCost > originalElectricalCost + 1e-9) continue;

        const candidateDeficit =
          deficitByIndex[startIndex]! +
          segmentLength * Math.max(0, this.problem.traceWidth - width);
        const candidateLength = lengthByIndex[startIndex]! + segmentLength;
        if (
          candidateDeficit < deficitByIndex[endIndex]! - 1e-9 ||
          (Math.abs(candidateDeficit - deficitByIndex[endIndex]!) <= 1e-9 &&
            candidateLength < lengthByIndex[endIndex]! - 1e-9)
        ) {
          deficitByIndex[endIndex] = candidateDeficit;
          lengthByIndex[endIndex] = candidateLength;
          previousIndex[endIndex] = startIndex;
        }
      }
    }

    const simplified: SearchNode[] = [];
    let cursor = points.length - 1;
    while (cursor >= 0) {
      simplified.push(points[cursor]!);
      if (cursor === 0) break;
      cursor = previousIndex[cursor]!;
      // Consecutive raw edges are always valid, so this is defensive only.
      if (cursor < 0) return points;
    }
    simplified.reverse();
    return this.removeRedundantCollinearPoints(simplified);
  }

  private removeRedundantCollinearPoints(points: SearchNode[]) {
    return points.filter((point, index, allPoints) => {
      if (index === 0 || index === allPoints.length - 1) return true;
      const previous = allPoints[index - 1]!;
      const next = allPoints[index + 1]!;
      const cross =
        (point.x - previous.x) * (next.y - point.y) -
        (point.y - previous.y) * (next.x - point.x);
      const sameWidth =
        Math.abs(
          this.getSafeSegmentWidth(previous, point) -
            this.getSafeSegmentWidth(point, next),
        ) < 1e-9;
      return Math.abs(cross) > 1e-8 || !sameWidth;
    });
  }

  private pointToCell(point: Point) {
    return {
      column: clamp(
        Math.round((point.x - this.origin.x) / this.problem.gridSize),
        0,
        this.columns - 1,
      ),
      row: clamp(
        Math.round((point.y - this.origin.y) / this.problem.gridSize),
        0,
        this.rows - 1,
      ),
    };
  }

  private cellToPoint(row: number, column: number): Point {
    return {
      x: this.origin.x + column * this.problem.gridSize,
      y: this.origin.y + row * this.problem.gridSize,
    };
  }

  private toStateIndex(
    node: Pick<
      SearchNode,
      "row" | "column" | "x" | "y" | "layerIndex" | "viaCount" | "viaPoints"
    >,
  ) {
    const baseStateIndex =
      ((node.viaCount * this.problem.layers.length + node.layerIndex) *
        this.rows +
        node.row) *
        this.columns +
      node.column;
    if (
      node.viaCount !== 1 ||
      node.viaPoints.length === 0 ||
      distance(node, node.viaPoints[0]!) >=
        this.problem.viaHoleDiameter +
          this.problem.obstacleIndex.minViaHoleEdgeToViaHoleEdgeClearance -
          1e-9
    ) {
      return baseStateIndex;
    }
    const firstViaCell = this.pointToCell(node.viaPoints[0]!);
    const viaHistoryIndex =
      1 + firstViaCell.row * this.columns + firstViaCell.column;
    return baseStateIndex + viaHistoryIndex * this.baseStateCount;
  }

  private heuristic(point: Point) {
    return distance(point, this.problem.end);
  }

  private createStats() {
    return {
      phase: "layer-aware-grid-search",
      gridSize: this.problem.gridSize,
      traceWidth: this.problem.traceWidth,
      startNeckWidth: this.problem.startNeckWidth,
      endNeckWidth: this.problem.endNeckWidth,
      maxViaCount: this.problem.maxViaCount,
      minViaCount: this.problem.minViaCount,
      openStates: this.open.size,
      closedStates: this.closedStateCount,
      trackedStates: this.bestCost.size,
      stateSpaceUpperBound: this.stateSpaceUpperBound,
    };
  }

  computeProgress() {
    return Math.min(0.99, this.iterations / this.MAX_ITERATIONS);
  }

  override getOutput() {
    return this.output;
  }

  override getConstructorParams() {
    const { obstacleIndex: _obstacleIndex, ...serializableProblem } =
      this.problem;
    return [serializableProblem];
  }

  override visualize(): GraphicsObject {
    const visitedPoints = this.nodes
      .filter((node) => this.closed.has(this.toStateIndex(node)))
      .slice(-2_000)
      .map((node) => ({
        x: node.x,
        y: node.y,
        color: `${LAYER_COLORS[node.layerIndex % LAYER_COLORS.length]}55`,
      }));
    const lines: NonNullable<GraphicsObject["lines"]> = [];
    const circles: NonNullable<GraphicsObject["circles"]> = [];
    const outputRoute = this.output?.route ?? [];
    for (let index = 0; index < outputRoute.length - 1; index++) {
      const start = outputRoute[index];
      const end = outputRoute[index + 1];
      if (
        start?.route_type === "wire" &&
        end?.route_type === "wire" &&
        start.layer === end.layer
      ) {
        const layerIndex = this.problem.layers.indexOf(start.layer);
        lines.push({
          points: [start, end],
          strokeColor: LAYER_COLORS[layerIndex % LAYER_COLORS.length] ?? "#333",
          strokeWidth: start.width,
        });
      }
      if (start?.route_type === "via") {
        circles.push({
          center: start,
          radius: (start.via_diameter ?? this.problem.viaDiameter) / 2,
          fill: "#d4a017",
        });
      }
    }
    return {
      coordinateSystem: "cartesian",
      title: this.getSolverName(),
      rects: [
        {
          center: {
            x: (this.searchBounds.minX + this.searchBounds.maxX) / 2,
            y: (this.searchBounds.minY + this.searchBounds.maxY) / 2,
          },
          width: this.searchBounds.maxX - this.searchBounds.minX,
          height: this.searchBounds.maxY - this.searchBounds.minY,
          stroke: "#777",
        },
      ],
      points: [
        ...visitedPoints,
        { ...this.problem.start, color: "green", label: "reroute start" },
        { ...this.problem.end, color: "purple", label: "reroute target" },
      ],
      lines,
      circles,
      texts: [],
    };
  }
}
