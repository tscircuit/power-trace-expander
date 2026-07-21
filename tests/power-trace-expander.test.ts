import { expect, test } from "bun:test";
import type { SimpleRouteJson } from "@tscircuit/core";
import { centralObstacleFixture } from "../fixtures/central-obstacle";
import {
  PowerTraceExpanderAutorouter,
  PowerTraceExpanderSolver,
  SpatialObstacleIndex,
} from "../src";

test("keeps a trace that already meets its nominal width byte-for-byte", () => {
  const input = structuredClone(centralObstacleFixture);
  input.obstacles = [];
  for (const point of input.traces![0]!.route) {
    if (point.route_type === "wire") point.width = 0.8;
  }
  const originalTraces = structuredClone(input.traces!);
  const solver = new PowerTraceExpanderSolver(input);

  solver.solve();

  expect(solver.solved).toBe(true);
  expect(solver.keptTraceCount).toBe(1);
  expect(solver.recreatedTraceCount).toBe(0);
  expect(solver.getOutput()).toEqual(originalTraces);
});

test("widens clear intervals and obstacle-reroutes a blocked interval", () => {
  const solver = new PowerTraceExpanderSolver(
    structuredClone(centralObstacleFixture),
  );

  solver.step();
  expect(solver.solved).toBe(false);
  expect(solver.stats.phase).toBe("evaluate-segment");

  solver.solve();

  const wirePoints = solver
    .getOutput()[0]!
    .route.filter((point) => point.route_type === "wire");
  expect(solver.solved).toBe(true);
  expect(solver.failed).toBe(false);
  expect(solver.expandedSegmentCount).toBeGreaterThan(0);
  expect(solver.reroutedSegmentCount).toBeGreaterThan(0);
  expect(solver.attemptedGridCount).toBeGreaterThan(0);
  expect(wirePoints.every((point) => point.width >= 0.8)).toBe(true);
  expect(wirePoints.some((point) => Math.abs(point.y) > 1)).toBe(true);
});

test("uses short indexed rectangles for a rotated obstacle", () => {
  const input: SimpleRouteJson = {
    ...structuredClone(centralObstacleFixture),
    traces: [],
    obstacles: [
      {
        type: "rect",
        center: { x: 0, y: 0 },
        width: 4,
        height: 0.5,
        ccwRotationDegrees: 45,
        layers: ["top"],
        connectedTo: [],
      },
    ],
  };
  const index = new SpatialObstacleIndex(input, []);

  expect(index.items.length).toBeGreaterThan(4);
  expect(
    index.collides({
      start: { x: -2, y: -2 },
      end: { x: 2, y: 2 },
      layer: "top",
      width: 0.2,
      connectionNames: ["OTHER_NET"],
    }),
  ).toBe(true);
  expect(
    index.collides({
      start: { x: -2, y: 2 },
      end: { x: 2, y: 2 },
      layer: "top",
      width: 0.2,
      connectionNames: ["OTHER_NET"],
    }),
  ).toBe(false);
});

test("keeps separate same-net traces and vias in collision checks", () => {
  const input = structuredClone(centralObstacleFixture);
  input.obstacles = [];
  input.traces = [
    {
      type: "pcb_trace",
      pcb_trace_id: "nearby_same_net",
      connection_name: "POWER",
      route: [
        {
          route_type: "wire",
          x: -1,
          y: 0.4,
          width: 0.2,
          layer: "top",
        },
        {
          route_type: "wire",
          x: 1,
          y: 0.4,
          width: 0.2,
          layer: "top",
        },
      ],
    },
  ];
  const index = new SpatialObstacleIndex(input, input.traces);

  expect(
    index.collides({
      start: { x: -1, y: 0 },
      end: { x: 1, y: 0 },
      layer: "top",
      width: 0.4,
      connectionNames: ["POWER"],
    }),
  ).toBe(true);
});

test("does not ignore vias inside a replaced range", () => {
  const input = structuredClone(centralObstacleFixture);
  input.obstacles = [];
  input.traces = [
    {
      type: "pcb_trace",
      pcb_trace_id: "trace_with_via",
      connection_name: "POWER",
      route: [
        {
          route_type: "via",
          x: 0,
          y: 0,
          from_layer: "top",
          to_layer: "bottom",
          via_diameter: 0.6,
        },
      ],
    },
  ];
  const index = new SpatialObstacleIndex(input, input.traces);

  expect(
    index.collides({
      start: { x: -1, y: 0 },
      end: { x: 0, y: 0 },
      layer: "top",
      width: 0.4,
      connectionNames: ["POWER"],
      ignoreTraceIndex: 0,
      ignoreRouteRange: { start: 0, end: 1 },
    }),
  ).toBe(true);
});

test("autorouter adapter emits a tscircuit-compatible complete event", () => {
  const autorouter = new PowerTraceExpanderAutorouter(
    structuredClone(centralObstacleFixture),
  );
  let completedTraceCount = 0;
  let error: Error | undefined;
  autorouter.on("complete", ({ traces }) => {
    completedTraceCount = traces.length;
  });
  autorouter.on("error", (event) => {
    error = event.error;
  });

  autorouter.start();

  expect(error).toBeUndefined();
  expect(completedTraceCount).toBe(1);
});
