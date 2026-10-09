import { expect, test } from "bun:test";
import "bun-match-svg";
import {
  getSvgFromGraphicsObject,
  stackGraphicsHorizontally,
  type GraphicsObject,
} from "graphics-debug";
import { ObstacleAwareGridRouteSolver } from "../src/ObstacleAwareGridRouteSolver";
import { SpatialObstacleIndex } from "../src/SpatialObstacleIndex";
import type { CollisionQuery, PowerTraceExpanderInput } from "../src/types";

test("prunes non-improving grid moves while preserving ordinary and off-grid octilinear routes", async (): Promise<void> => {
  const input: PowerTraceExpanderInput = {
    bounds: { minX: -2, minY: -3, maxX: 7, maxY: 3 },
    layerCount: 1,
    minTraceWidth: 0.2,
    connections: [],
    obstacles: [
      {
        type: "rect",
        center: { x: 2.5, y: 0 },
        width: 0.8,
        height: 2,
        layers: ["top"],
        connectedTo: ["other"],
      },
    ],
  };
  const cases = [
    {
      octilinear: false,
      offset: 0,
      iterations: 173,
      baselineCollisionChecks: 782,
      points: [
        [0.03, -0.02],
        [2, 1.25],
        [3, 1.25],
        [5.04, 0.06],
      ],
    },
    {
      octilinear: false,
      offset: 0.125,
      iterations: 239,
      baselineCollisionChecks: 977,
      points: [
        [0.03, -0.02],
        [2.125, -1.375],
        [2.875, -1.375],
        [5.04, 0.06],
      ],
    },
    {
      octilinear: true,
      offset: 0,
      iterations: 182,
      baselineCollisionChecks: 744,
      points: [
        [0.03, -0.02],
        [0.03, -0.03],
        [0.25, -0.25],
        [1, -0.25],
        [2, -1.25],
        [3, -1.25],
        [3.75, -0.5],
        [4, -0.5],
        [4.25, -0.25],
        [4.5, -0.25],
        [4.75, 0],
        [5, 0],
        [5, 0.019999999999999962],
        [5.04, 0.06],
      ],
    },
    {
      octilinear: true,
      offset: 0.125,
      iterations: 249,
      baselineCollisionChecks: 942,
      points: [
        [0.03, -0.02],
        [0.23, -0.02],
        [0.375, 0.125],
        [0.875, 0.125],
        [2.125, 1.375],
        [2.875, 1.375],
        [3.625, 0.625],
        [3.875, 0.625],
        [4.125, 0.375],
        [4.625, 0.375],
        [4.875, 0.125],
        [5.105, 0.125],
        [5.04, 0.06],
      ],
    },
  ];
  const panels: GraphicsObject[] = [];
  const titles: string[] = [];
  for (const fixture of cases) {
    const obstacleIndex = new SpatialObstacleIndex(input, []);
    const collides = obstacleIndex.collides.bind(obstacleIndex);
    let collisionChecks = 0;
    obstacleIndex.collides = (query: CollisionQuery): boolean => {
      collisionChecks++;
      return collides(query);
    };
    const solver = new ObstacleAwareGridRouteSolver({
      start: { x: 0.03, y: -0.02 },
      end: { x: 5.04, y: 0.06 },
      layer: "top",
      traceWidth: 0.2,
      gridSize: 0.25,
      gridOffset: { x: fixture.offset, y: fixture.offset },
      connectionNames: ["power"],
      obstacleIndex,
      ignoreTraceIndex: -1,
      ignoreRouteRange: { start: 0, end: 1 },
      bounds: input.bounds,
      searchPadding: 2,
      requireOctilinear: fixture.octilinear,
    });
    solver.solve();
    expect(solver.solved).toBe(true);
    expect(solver.failed).toBe(false);
    expect(solver.iterations).toBe(fixture.iterations);
    expect(solver.getOutput()?.points).toEqual(
      fixture.points.map(([x, y]) => ({ x, y })),
    );
    // Baseline counts were measured with main's original loop on these exact
    // cases. The snapshot draws the actual output and measured work; the
    // assertions above independently require the unchanged golden route.
    expect(collisionChecks).toBeLessThan(520);
    const graphic = solver.visualize();
    panels.push({
      ...graphic,
      rects: [
        ...graphic.rects!,
        ...input.obstacles.map((obstacle) => ({
          center: obstacle.center,
          width: obstacle.width,
          height: obstacle.height,
          fill: "rgba(100,116,139,0.2)",
          stroke: "#475569",
        })),
      ],
      texts: [
        `Collision checks: ${fixture.baselineCollisionChecks} -> ${collisionChecks}`,
        `Same route and ${solver.iterations} iterations`,
        fixture.octilinear
          ? "Off-grid connector keeps its actual cost"
          : "Skip copper checks for non-improving moves",
      ].map((text, index) => ({
        x: input.bounds.minX,
        y: input.bounds.minY - 0.5 - index * 0.45,
        text,
        fontSize: 0.25,
        anchorSide: "center_left" as const,
        color: "#334155",
      })),
    });
    titles.push(
      `${fixture.octilinear ? "Octilinear" : "Ordinary"}; offset ${fixture.offset}`,
    );
  }
  const svg = getSvgFromGraphicsObject(
    stackGraphicsHorizontally(panels, { titles }),
    { backgroundColor: "white", svgWidth: 1600, svgHeight: 420 },
  ).replace(/[ \t]+$/gm, "");
  await expect(svg).toMatchSvgSnapshot(import.meta.path);
});
