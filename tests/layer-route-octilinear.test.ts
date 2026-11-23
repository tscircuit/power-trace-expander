import { expect, test } from "bun:test";
import { LayerAwareGridRouteSolver } from "../src/LayerAwareGridRouteSolver";
import { SpatialObstacleIndex } from "../src/SpatialObstacleIndex";
import { isOctilinearSegment } from "../src/octilinear";
import type { SimpleRouteJson } from "../src/types";

test("multilayer width simplification preserves native grid headings", (): void => {
  const input: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.08,
    bounds: { minX: -5, maxX: 5, minY: -5, maxY: 5 },
    obstacles: [],
    connections: [],
  };
  for (const exponent of [1, 2]) {
    const solver = new LayerAwareGridRouteSolver({
      start: { x: -3, y: -2 },
      end: { x: 3, y: 2.5 },
      originalStartLayer: "top",
      originalEndLayer: "top",
      startLayers: ["top"],
      endLayers: ["top"],
      layers: ["top", "bottom"],
      traceWidth: 0.15,
      startNeckWidth: 0.15,
      endNeckWidth: 0.15,
      maxStartNeckLength: 0,
      maxEndNeckLength: 0,
      neckPenaltyExponent: exponent,
      viaDiameter: 0.35,
      viaHoleDiameter: 0.15,
      minViaCount: 0,
      maxViaCount: 0,
      viaCost: 1,
      gridSize: 0.05,
      gridOffset: { x: 0, y: 0 },
      connectionNames: ["signal"],
      obstacleIndex: new SpatialObstacleIndex(input, []),
      ignoreTraceIndex: -1,
      ignoreRouteRange: { start: 0, end: 1 },
      softTraceIndices: [],
      fixedVias: [],
      bounds: input.bounds,
      searchPadding: 1,
    });
    solver.solve();
    expect(solver.solved).toBe(true);
    const output = solver.getOutput()!;
    expect(output.route[0]).toMatchObject({ x: -3, y: -2 });
    expect(output.route.at(-1)).toMatchObject({ x: 3, y: 2.5 });
    for (let index = 1; index < output.route.length; index++) {
      const start = output.route[index - 1]!,
        end = output.route[index]!;
      if (
        start.route_type === "wire" &&
        end.route_type === "wire" &&
        start.layer === end.layer
      )
        expect(isOctilinearSegment(start, end)).toBe(true);
    }
  }
});
