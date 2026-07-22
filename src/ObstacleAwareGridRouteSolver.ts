import { BaseSolver } from "@tscircuit/solver-utils";
import type { GraphicsObject } from "graphics-debug";
import { clamp, pointsEqual } from "./geometry";
import {
  calculateOctilinearPaths,
  getPathLength,
  isOctilinearSegment,
} from "./octilinear";
import type { GridRouteOutput, GridRouteProblem, Point } from "./types";

type SearchNode = {
  row: number;
  column: number;
  x: number;
  y: number;
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

  pop(): number {
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

export class ObstacleAwareGridRouteSolver extends BaseSolver {
  readonly problem: GridRouteProblem;
  readonly searchBounds: GridRouteProblem["bounds"];
  readonly rows: number;
  readonly columns: number;
  readonly origin: Point;

  private readonly nodes: SearchNode[] = [];
  private readonly open = new MinHeap();
  private readonly bestCost: Float64Array;
  private readonly closed: Uint8Array;
  private closedCellCount = 0;
  private targetCell: { row: number; column: number };
  private output: GridRouteOutput | null = null;

  constructor(problem: GridRouteProblem) {
    super();
    this.problem = problem;
    const radius = problem.traceWidth / 2 + problem.obstacleIndex.clearance;
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
    this.bestCost = new Float64Array(this.rows * this.columns).fill(
      Number.POSITIVE_INFINITY,
    );
    this.closed = new Uint8Array(this.rows * this.columns);
    if (
      this.endpointCollides(problem.start) ||
      this.endpointCollides(problem.end)
    ) {
      this.failed = true;
      this.error = "Grid-route endpoint violates obstacle clearance";
      this.targetCell = { row: 0, column: 0 };
      this.MAX_ITERATIONS = 1;
      this.stats = this.createStats();
      return;
    }
    const startCell = this.pointToCell(problem.start);
    this.targetCell = this.pointToCell(problem.end);
    const startNode: SearchNode = {
      ...startCell,
      x: problem.start.x,
      y: problem.start.y,
      g: 0,
      f: this.heuristic(problem.start),
      parentIndex: -1,
    };
    this.nodes.push(startNode);
    this.open.push(0, startNode.f);
    this.bestCost[this.toFlatIndex(startCell.row, startCell.column)] = 0;
    this.MAX_ITERATIONS = Math.min(
      5_000,
      Math.max(1_000, this.rows * this.columns * 2),
    );
    this.stats = this.createStats();
  }

  private endpointCollides(point: Point) {
    return this.problem.obstacleIndex.collides({
      start: point,
      end: point,
      layer: this.problem.layer,
      width: this.problem.traceWidth,
      connectionNames: this.problem.connectionNames,
      ignoreTraceIndex: this.problem.ignoreTraceIndex,
      ignoreRouteRange: this.problem.ignoreRouteRange,
      obstacleClearance: this.problem.obstacleClearance,
    });
  }

  override getSolverName() {
    return `ObstacleAwareGridRouteSolver(${this.problem.gridSize.toFixed(3)}mm)`;
  }

  override _step() {
    if (this.open.size === 0) {
      this.failed = true;
      this.error = "No collision-free grid route found";
      return;
    }

    const nodeIndex = this.open.pop();
    const node = this.nodes[nodeIndex]!;
    const flatIndex = this.toFlatIndex(node.row, node.column);
    if (this.closed[flatIndex]) return;
    this.closed[flatIndex] = 1;
    this.closedCellCount++;

    if (
      node.row === this.targetCell.row &&
      node.column === this.targetCell.column &&
      this.getAllowedConnector(node, this.problem.end) !== null
    ) {
      this.output = {
        points: this.reconstructPath(nodeIndex),
        traceWidth: this.problem.traceWidth,
        gridSize: this.problem.gridSize,
        gridOffset: this.problem.gridOffset,
      };
      this.solved = true;
      this.stats = this.createStats();
      return;
    }

    for (const [deltaRow, deltaColumn] of DIRECTIONS) {
      const row = node.row + deltaRow;
      const column = node.column + deltaColumn;
      if (row < 0 || row >= this.rows || column < 0 || column >= this.columns)
        continue;
      const nextFlatIndex = this.toFlatIndex(row, column);
      if (this.closed[nextFlatIndex]) continue;
      const point = this.cellToPoint(row, column);
      const connector = this.getAllowedConnector(node, point);
      if (connector === null) continue;

      const moveCost =
        node.parentIndex === -1 && this.problem.requireOctilinear
          ? getPathLength(connector)
          : this.problem.gridSize *
            (deltaRow !== 0 && deltaColumn !== 0 ? Math.SQRT2 : 1);
      const g = node.g + moveCost;
      if (g >= this.bestCost[nextFlatIndex]!) continue;
      this.bestCost[nextFlatIndex] = g;
      const f = g + this.heuristic(point);
      const nextNodeIndex = this.nodes.length;
      this.nodes.push({
        row,
        column,
        ...point,
        g,
        f,
        parentIndex: nodeIndex,
      });
      this.open.push(nextNodeIndex, f);
    }
    this.stats = this.createStats();
  }

  private segmentCollides(start: Point, end: Point) {
    return this.problem.obstacleIndex.collides({
      start,
      end,
      layer: this.problem.layer,
      width: this.problem.traceWidth,
      connectionNames: this.problem.connectionNames,
      ignoreTraceIndex: this.problem.ignoreTraceIndex,
      ignoreRouteRange: this.problem.ignoreRouteRange,
      obstacleClearance: this.problem.obstacleClearance,
    });
  }

  private getAllowedConnector(start: SearchNode | Point, end: Point) {
    const isTerminalConnector =
      this.problem.requireOctilinear &&
      (("parentIndex" in start && start.parentIndex === -1) ||
        pointsEqual(end, this.problem.end));
    if (!isTerminalConnector) {
      return this.segmentCollides(start, end) ? null : [start, end];
    }
    return (
      calculateOctilinearPaths(start, end).find((path) =>
        path
          .slice(0, -1)
          .every(
            (point, index) => !this.segmentCollides(point, path[index + 1]!),
          ),
      ) ?? null
    );
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

  private toFlatIndex(row: number, column: number) {
    return row * this.columns + column;
  }

  private heuristic(point: Point) {
    return Math.hypot(
      this.problem.end.x - point.x,
      this.problem.end.y - point.y,
    );
  }

  private reconstructPath(goalNodeIndex: number) {
    const points: Point[] = [];
    let nodeIndex = goalNodeIndex;
    while (nodeIndex >= 0) {
      const node = this.nodes[nodeIndex]!;
      points.push({ x: node.x, y: node.y });
      nodeIndex = node.parentIndex;
    }
    points.reverse();
    if (!pointsEqual(points[0]!, this.problem.start)) {
      points.unshift({ ...this.problem.start });
    }
    if (!pointsEqual(points[points.length - 1]!, this.problem.end)) {
      points.push({ ...this.problem.end });
    }
    if (this.problem.requireOctilinear) {
      const octilinearPoints: Point[] = [points[0]!];
      for (let index = 0; index < points.length - 1; index++) {
        const start = points[index]!;
        const end = points[index + 1]!;
        const isTerminal = index === 0 || index === points.length - 2;
        const connector = isTerminal
          ? this.getAllowedConnector(
              index === 0
                ? ({ ...start, parentIndex: -1 } as SearchNode)
                : start,
              end,
            )
          : [start, end];
        if (!connector) return points;
        octilinearPoints.push(...connector.slice(1));
      }
      return octilinearPoints.filter((point, index, allPoints) => {
        if (index === 0 || index === allPoints.length - 1) return true;
        const previous = allPoints[index - 1]!;
        const next = allPoints[index + 1]!;
        const cross =
          (point.x - previous.x) * (next.y - point.y) -
          (point.y - previous.y) * (next.x - point.x);
        return Math.abs(cross) > 1e-8 || !isOctilinearSegment(previous, next);
      });
    }
    const lineOfSightPoints: Point[] = [points[0]!];
    let anchorIndex = 0;
    while (anchorIndex < points.length - 1) {
      let nextIndex = points.length - 1;
      while (
        nextIndex > anchorIndex + 1 &&
        this.segmentCollides(points[anchorIndex]!, points[nextIndex]!)
      ) {
        nextIndex--;
      }
      lineOfSightPoints.push(points[nextIndex]!);
      anchorIndex = nextIndex;
    }
    return lineOfSightPoints.filter((point, index, allPoints) => {
      if (index === 0 || index === allPoints.length - 1) return true;
      const previous = allPoints[index - 1]!;
      const next = allPoints[index + 1]!;
      const cross =
        (point.x - previous.x) * (next.y - point.y) -
        (point.y - previous.y) * (next.x - point.x);
      return Math.abs(cross) > 1e-8;
    });
  }

  private createStats() {
    return {
      phase: "obstacle-aware-grid-search",
      gridSize: this.problem.gridSize,
      traceWidth: this.problem.traceWidth,
      gridOffset: this.problem.gridOffset,
      openCells: this.open.size,
      closedCells: this.closedCellCount,
      gridCells: this.rows * this.columns,
    };
  }

  computeProgress() {
    return Math.min(0.99, this.iterations / this.MAX_ITERATIONS);
  }

  override getOutput(): GridRouteOutput | null {
    return this.output;
  }

  override getConstructorParams() {
    const { obstacleIndex: _obstacleIndex, ...serializableProblem } =
      this.problem;
    return [serializableProblem];
  }

  override visualize(): GraphicsObject {
    const visitedPoints = this.nodes
      .filter((node) => this.closed[this.toFlatIndex(node.row, node.column)])
      .slice(-2_000)
      .map((node) => ({ x: node.x, y: node.y, color: "rgba(0,90,255,0.22)" }));
    const output = this.output?.points ?? [];
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
      lines:
        output.length > 1
          ? [
              {
                points: output,
                strokeColor: "#00a050",
                strokeWidth: this.problem.traceWidth,
              },
            ]
          : [],
      circles: [],
      texts: [],
    };
  }
}
