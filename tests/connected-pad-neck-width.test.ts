import { expect, test } from "bun:test";
import type { SimpleRouteJson, SimplifiedPcbTrace } from "@tscircuit/core";
import {
  PowerTraceClearanceRepairSolver,
  PowerTraceExpanderSolver,
  SpatialObstacleIndex,
  type PowerTraceExpanderInput,
} from "../src";
import type { WireRoutePoint } from "../src/types";

const wire = (x: number, width: number, y = 0): WireRoutePoint => ({
  route_type: "wire" as const,
  x,
  y,
  width,
  layer: "top",
});

/**
 * Width-safe route reversal matching @tscircuit/core's reversePcbTraceRoute
 * (tscircuit/core#3375): each reversed segment [i, i + 1] preserves the
 * constant segment width that the corresponding forward segment carried, and
 * the final wire point of each same-layer wire run preserves that run's
 * terminal segment width.
 */
const reversePcbTraceRoute = (
  route: SimplifiedPcbTrace["route"],
): SimplifiedPcbTrace["route"] => {
  const reversed = structuredClone(route).reverse();
  let index = 0;
  while (index < reversed.length) {
    const startPoint = reversed[index];
    if (startPoint?.route_type !== "wire") {
      index++;
      continue;
    }
    let runEnd = index;
    while (runEnd + 1 < reversed.length) {
      const candidate = reversed[runEnd + 1];
      if (
        candidate?.route_type !== "wire" ||
        candidate.layer !== startPoint.layer
      ) {
        break;
      }
      runEnd++;
    }
    if (runEnd > index) {
      const segmentWidths: number[] = [];
      for (let pointIndex = index; pointIndex < runEnd; pointIndex++) {
        const nextPoint = reversed[pointIndex + 1];
        if (nextPoint?.route_type === "wire") {
          segmentWidths.push(nextPoint.width);
        }
      }
      for (let offset = 0; offset < segmentWidths.length; offset++) {
        const target = reversed[index + offset];
        if (target?.route_type === "wire") {
          target.width = segmentWidths[offset]!;
        }
      }
      const terminalPoint = reversed[runEnd];
      const lastSegmentWidth = segmentWidths.at(-1);
      if (
        terminalPoint?.route_type === "wire" &&
        lastSegmentWidth !== undefined
      ) {
        terminalPoint.width = lastSegmentWidth;
      }
    }
    index = runEnd + 1;
  }
  return reversed;
};

const getPositiveMicrosegments = (
  traces: SimplifiedPcbTrace[],
  threshold = 1e-3,
) => {
  const microsegments: Array<{
    traceId: string;
    routeIndex: number;
    length: number;
    start: { x: number; y: number; width: number };
    end: { x: number; y: number; width: number };
  }> = [];
  for (const trace of traces) {
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
      const length = Math.hypot(end.x - start.x, end.y - start.y);
      if (length > 0 && length < threshold) {
        microsegments.push({
          traceId: trace.pcb_trace_id,
          routeIndex,
          length,
          start: { x: start.x, y: start.y, width: start.width },
          end: { x: end.x, y: end.y, width: end.width },
        });
      }
    }
  }
  return microsegments;
};

test("does not widen a power escape beyond its connected pad", () => {
  const input = {
    layerCount: 2,
    minTraceWidth: 0.5,
    defaultObstacleMargin: 0.1,
    bounds: { minX: -1, minY: -2, maxX: 4, maxY: 2 },
    obstacles: [
      {
        type: "rect" as const,
        center: { x: 0, y: 0 },
        width: 1.1,
        height: 0.3,
        layers: ["top"],
        connectedTo: ["pcb_smtpad_left", "POWER"],
      },
      {
        type: "rect" as const,
        center: { x: 3, y: 0 },
        width: 0.54,
        height: 0.64,
        layers: ["top"],
        connectedTo: ["pcb_smtpad_right", "POWER"],
      },
    ],
    connections: [
      {
        name: "POWER",
        nominalTraceWidth: 0.5,
        pointsToConnect: [
          { x: 0, y: 0, layer: "top" },
          { x: 3, y: 0, layer: "top" },
        ],
      },
    ],
    traces: [
      {
        type: "pcb_trace" as const,
        pcb_trace_id: "power",
        connection_name: "POWER",
        route: [
          wire(0, 0.3),
          wire(0.00003, 0.3, -0.000187),
          wire(1.1, 0.3),
          wire(2.46, 0.5),
          wire(3, 0.5),
        ],
      },
    ],
  } satisfies PowerTraceExpanderInput;
  const initialIndex = new SpatialObstacleIndex(input, input.traces);
  expect(
    initialIndex.getConnectedPadEndpointWidthLimitAtPoint(
      {
        start: input.traces[0]!.route[0]!,
        end: input.traces[0]!.route[1]!,
        layer: "top",
        width: 0.5,
        connectionNames: ["POWER"],
        ignoreTraceIndex: 0,
        ignoreRouteRange: { start: 0, end: 1 },
      },
      input.traces[0]!.route[0]!,
    ),
  ).toBeCloseTo(0.3, 6);

  const solver = new PowerTraceExpanderSolver(input);
  solver.solve();

  const outputTrace = solver.getOutput()[0]!;
  const wires = outputTrace.route.filter(
    (point): point is WireRoutePoint => point.route_type === "wire",
  );
  expect(solver.solved).toBe(true);
  // Single exact pad-boundary transition point at x = 0.55 (no +-epsilon pair).
  const boundaryPoints = wires.filter(
    (point) => Math.abs(point.x - 0.55) < 1e-4,
  );
  expect(boundaryPoints).toHaveLength(1);
  expect(boundaryPoints[0]!.x).toBeCloseTo(0.55, 9);
  expect(boundaryPoints[0]!.width).toBeCloseTo(0.5, 6);
  expect(
    wires
      .filter((point) => point.x < 0.55 - 1e-9)
      .every((point) => point.width <= 0.3 + 1e-9),
  ).toBe(true);
  expect(
    wires.some(
      (point) => point.x >= 0.55 - 1e-9 && point.x < 2.7 && point.width >= 0.5,
    ),
  ).toBe(true);
  expect(getPositiveMicrosegments(solver.getOutput())).toEqual([]);
});

test("FR2355 pad-neck repair preserves pre-power microsegments and introduces no new < 1e-3 mm segments in either direction", () => {
  const simpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.15,
    nominalTraceWidth: 0.5,
    defaultObstacleMargin: 0.1,
    bounds: { minX: -1, minY: -2, maxX: 5, maxY: 2 },
    obstacles: [
      {
        type: "rect" as const,
        center: { x: 0, y: 0 },
        width: 1.1,
        height: 0.3,
        layers: ["top"],
        connectedTo: ["pcb_smtpad_left", "POWER"],
      },
      {
        type: "rect" as const,
        center: { x: 3, y: 0 },
        width: 0.54,
        height: 0.3,
        layers: ["top"],
        connectedTo: ["pcb_smtpad_right", "POWER"],
      },
    ],
    connections: [
      {
        name: "POWER",
        nominalTraceWidth: 0.5,
        pointsToConnect: [
          { x: 0, y: 0, layer: "top" },
          { x: 3, y: 0, layer: "top" },
        ],
      },
      {
        name: "SIGNAL",
        nominalTraceWidth: 0.15,
        pointsToConnect: [
          { x: 1.2, y: 0.42, layer: "top" },
          { x: 2.0, y: 0.42, layer: "top" },
        ],
      },
    ],
  } satisfies SimpleRouteJson;

  // Include the FR2355 pre-power microsegment (0, 0) -> (0.00003, -0.000187)
  // on POWER as well as an unrelated pre-power microsegment on SIGNAL, plus a
  // close foreign SIGNAL segment that requires foreign-trace clearance necking.
  const traces: SimplifiedPcbTrace[] = [
    {
      type: "pcb_trace",
      pcb_trace_id: "power",
      connection_name: "POWER",
      route: [
        wire(0, 0.5),
        wire(0.00003, 0.5, -0.000187),
        wire(1.2, 0.5),
        wire(2.0, 0.5),
        wire(3, 0.5),
      ],
    },
    {
      type: "pcb_trace",
      pcb_trace_id: "signal_with_preexisting_microsegment",
      connection_name: "SIGNAL",
      route: [
        wire(1.2, 0.15, 0.42),
        wire(1.20003, 0.15, 0.419813),
        wire(2.0, 0.15, 0.42),
      ],
    },
  ];

  const beforeMicrosegments = getPositiveMicrosegments(traces);
  expect(beforeMicrosegments).toHaveLength(2);

  const forwardRepair = new PowerTraceClearanceRepairSolver({
    simpleRouteJson,
    traces,
    traceIndices: [0],
  });
  forwardRepair.solve();

  const repairedTraces = forwardRepair.getOutput();
  const afterMicrosegments = getPositiveMicrosegments(repairedTraces);
  // PowerTraceClearanceRepairSolver introduces zero new positive wire segments
  // shorter than 1e-3 mm while preserving the two pre-existing microsegments.
  expect(afterMicrosegments).toHaveLength(2);
  expect(afterMicrosegments[0]!.traceId).toBe("power");
  expect(afterMicrosegments[0]!.length).toBeCloseTo(
    beforeMicrosegments[0]!.length,
    9,
  );
  expect(afterMicrosegments[0]!.start.width).toBeCloseTo(0.3, 6);
  expect(afterMicrosegments[1]).toEqual(beforeMicrosegments[1]);

  const forwardPower = repairedTraces[0]!;
  const forwardWires = forwardPower.route.filter(
    (point): point is WireRoutePoint => point.route_type === "wire",
  );
  // Single exact boundary point at left pad edge (x = 0.55) and right pad edge (x = 2.73).
  const leftBoundaryPoints = forwardWires.filter(
    (point) => Math.abs(point.x - 0.55) < 1e-4,
  );
  const rightBoundaryPoints = forwardWires.filter(
    (point) => Math.abs(point.x - 2.73) < 1e-4,
  );
  expect(leftBoundaryPoints).toHaveLength(1);
  expect(leftBoundaryPoints[0]!.x).toBeCloseTo(0.55, 9);
  expect(rightBoundaryPoints).toHaveLength(1);
  expect(rightBoundaryPoints[0]!.x).toBeCloseTo(2.73, 9);

  const reversedPower: SimplifiedPcbTrace = {
    ...forwardPower,
    route: reversePcbTraceRoute(forwardPower.route),
  };
  const reversedWires = reversedPower.route.filter(
    (point): point is WireRoutePoint => point.route_type === "wire",
  );
  expect(reversedWires).toHaveLength(forwardWires.length);

  // Every segment [i, i + 1] in the width-safe reversed route must have the
  // exact same endpoints and Circuit JSON width (start.width) as the
  // corresponding forward segment.
  for (let index = 0; index < forwardWires.length - 1; index++) {
    const forwardStart = forwardWires[index]!;
    const forwardEnd = forwardWires[index + 1]!;
    const reversedStart = reversedWires[forwardWires.length - 2 - index]!;
    const reversedEnd = reversedWires[forwardWires.length - 1 - index]!;
    expect(reversedStart.x).toBeCloseTo(forwardEnd.x, 9);
    expect(reversedStart.y).toBeCloseTo(forwardEnd.y, 9);
    expect(reversedEnd.x).toBeCloseTo(forwardStart.x, 9);
    expect(reversedEnd.y).toBeCloseTo(forwardStart.y, 9);
    expect(reversedStart.width).toBeCloseTo(forwardStart.width, 9);
  }

  // Verify pad-neck width and foreign-trace clearance in both directions.
  for (const candidatePower of [forwardPower, reversedPower]) {
    const obstacleIndex = new SpatialObstacleIndex(simpleRouteJson, [
      candidatePower,
      repairedTraces[1]!,
    ]);
    for (
      let routeIndex = 0;
      routeIndex < candidatePower.route.length - 1;
      routeIndex++
    ) {
      const start = candidatePower.route[routeIndex];
      const end = candidatePower.route[routeIndex + 1];
      if (
        !start ||
        !end ||
        start.route_type !== "wire" ||
        end.route_type !== "wire"
      ) {
        continue;
      }
      const midPoint = {
        x: (start.x + end.x) / 2,
        y: (start.y + end.y) / 2,
      };
      const padLimitAtMid = obstacleIndex.getConnectedPadWidthLimitAtPoint(
        {
          start,
          end,
          layer: start.layer,
          width: start.width,
          connectionNames: ["POWER"],
          ignoreTraceIndex: 0,
          ignoreRouteRange: { start: routeIndex, end: routeIndex + 1 },
        },
        midPoint,
      );
      if (padLimitAtMid !== null) {
        expect(start.width).toBeLessThanOrEqual(padLimitAtMid + 1e-9);
      }
      const foreignCollisions = obstacleIndex
        .findCollisions({
          start,
          end,
          layer: start.layer,
          width: start.width,
          connectionNames: ["POWER"],
          ignoreTraceIndex: 0,
          ignoreRouteRange: { start: routeIndex, end: routeIndex + 1 },
        })
        .filter(
          (collision) =>
            collision.kind === "trace" && collision.traceIndex !== 0,
        );
      expect(foreignCollisions).toEqual([]);
    }
  }

  // Running PowerTraceClearanceRepairSolver on the reversed route requires no
  // additional pad-neck or foreign-trace clearance repairs.
  const reversedRepair = new PowerTraceClearanceRepairSolver({
    simpleRouteJson,
    traces: [reversedPower, repairedTraces[1]!],
    traceIndices: [0],
  });
  reversedRepair.solve();
  expect(reversedRepair.repairedPadNeckSegmentCount).toBe(0);
  expect(reversedRepair.repairedSegmentCount).toBe(0);
  expect(getPositiveMicrosegments(reversedRepair.getOutput())).toHaveLength(2);
});
