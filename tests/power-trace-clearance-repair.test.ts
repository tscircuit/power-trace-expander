import { expect, test } from "bun:test";
import "bun-match-svg";
import "graphics-debug/matcher";
import type { SimpleRouteJson, SimplifiedPcbTrace } from "@tscircuit/core";
import { PowerTraceClearanceRepairSolver, SpatialObstacleIndex } from "../src";

const wire = (x: number, y: number, width: number) => ({
  route_type: "wire" as const,
  x,
  y,
  width,
  layer: "top" as const,
});

const problem = {
  layerCount: 2,
  minTraceWidth: 0.15,
  nominalTraceWidth: 1,
  defaultObstacleMargin: 0.1,
  minTraceToPadEdgeClearance: 0.1,
  minViaHoleDiameter: 0.2,
  minViaPadDiameter: 0.3,
  bounds: { minX: 9, maxX: 13, minY: -4, maxY: 0 },
  obstacles: [],
  connections: [
    {
      name: "MOTOR_B2",
      nominalTraceWidth: 1,
      pointsToConnect: [
        { x: 11.360820734793128, y: -2.365910377208615, layer: "top" },
        { x: 11.360820734793128, y: -2.8141792652068713, layer: "top" },
      ],
    },
    {
      name: "MOTOR_A2",
      nominalTraceWidth: 1,
      pointsToConnect: [
        { x: 10.675134, y: -2.3248660000000005, layer: "top" },
        { x: 11.4, y: -1.6, layer: "top" },
      ],
    },
  ],
  traces: [
    {
      type: "pcb_trace" as const,
      pcb_trace_id: "motor-b2",
      connection_name: "MOTOR_B2",
      route: [
        wire(11.360820734793128, -2.365910377208615, 0.175),
        wire(11.360820734793128, -2.8141792652068713, 0.65),
      ],
    },
    {
      type: "pcb_trace" as const,
      pcb_trace_id: "motor-a2",
      connection_name: "MOTOR_A2",
      route: [
        wire(10.675134, -2.3248660000000005, 0.25),
        wire(11.4, -1.6, 0.25),
      ],
    },
  ],
} satisfies SimpleRouteJson;

const getForeignTraceCollisionCount = (
  simpleRouteJson: SimpleRouteJson,
  traces: SimplifiedPcbTrace[],
) => {
  const conservativeTraces = structuredClone(traces);
  for (const trace of conservativeTraces) {
    for (let index = 0; index < trace.route.length - 1; index++) {
      const start = trace.route[index];
      const end = trace.route[index + 1];
      if (
        start?.route_type === "wire" &&
        end?.route_type === "wire" &&
        start.layer === end.layer
      ) {
        start.width = Math.max(start.width, end.width);
      }
    }
  }
  const obstacleIndex = new SpatialObstacleIndex(
    simpleRouteJson,
    conservativeTraces,
  );
  let collisionCount = 0;
  for (let traceIndex = 0; traceIndex < traces.length; traceIndex++) {
    const trace = traces[traceIndex]!;
    for (
      let routeIndex = 0;
      routeIndex < trace.route.length - 1;
      routeIndex++
    ) {
      const start = trace.route[routeIndex];
      const end = trace.route[routeIndex + 1];
      if (
        start?.route_type !== "wire" ||
        end?.route_type !== "wire" ||
        start.layer !== end.layer
      ) {
        continue;
      }
      const collisions = obstacleIndex.findCollisions({
        start,
        end,
        layer: start.layer,
        width: Math.max(start.width, end.width),
        connectionNames: [trace.pcb_trace_id, trace.connection_name].filter(
          (name): name is string => Boolean(name),
        ),
        ignoreTraceIndex: traceIndex,
        ignoreRouteRange: { start: routeIndex, end: routeIndex + 1 },
      });
      collisionCount += collisions.filter(
        (collision) =>
          collision.kind === "trace" &&
          collision.traceIndex !== undefined &&
          collision.traceIndex !== traceIndex,
      ).length;
    }
  }
  return collisionCount;
};

const getRouteGeometry = (traces: SimplifiedPcbTrace[]) =>
  traces.map((trace) =>
    trace.route.map((point) =>
      "x" in point && "y" in point
        ? { x: point.x, y: point.y }
        : { start: point.start, end: point.end },
    ),
  );

test("necks an endpoint-width transition that would collide after route reversal", async () => {
  const input = structuredClone(problem);
  expect(getForeignTraceCollisionCount(input, input.traces)).toBeGreaterThan(0);
  const beforeGeometry = getRouteGeometry(input.traces);
  const solver = new PowerTraceClearanceRepairSolver({
    simpleRouteJson: input,
    traces: input.traces,
  });

  solver.solve();

  const output = solver.getOutput();
  expect(solver.solved).toBe(true);
  expect(solver.failed).toBe(false);
  expect(solver.stats.repairedSegmentCount).toBe(1);
  expect(solver.stats.unresolvedSegmentCount).toBe(0);
  expect(getForeignTraceCollisionCount(input, output)).toBe(0);
  expect(getRouteGeometry(output)).toEqual(beforeGeometry);
  expect(output[0]!.route[1]!.route_type).toBe("wire");
  expect(
    output[0]!.route[1]!.route_type === "wire"
      ? output[0]!.route[1]!.width
      : undefined,
  ).toBeLessThan(0.65);
  await expect(solver.visualize()).toMatchGraphicsSvg(import.meta.path, {
    svgName: "direction-independent-trace-clearance",
  });
});
