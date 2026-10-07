import { expect, test } from "bun:test";
import { PowerTraceClearanceRepairSolver, SpatialObstacleIndex } from "../src";
import type {
  SimpleRouteJson,
  SimplifiedPcbTrace,
  WireRoutePoint,
} from "../src/types";

const wire = (x: number, width = 0.5, y = 0): WireRoutePoint => ({
  route_type: "wire",
  x,
  y,
  width,
  layer: "top",
});

const pad = (x: number, width = 1, height = 0.3) => ({
  type: "rect" as const,
  center: { x, y: 0 },
  width,
  height,
  layers: ["top"],
  connectedTo: [`pcb_smtpad_${x}`, "POWER"],
});

const problem = (
  route: SimplifiedPcbTrace["route"],
  obstacles = [pad(0)],
): SimpleRouteJson & { traces: SimplifiedPcbTrace[] } => ({
  layerCount: 2,
  minTraceWidth: 0.5,
  defaultObstacleMargin: 0.1,
  bounds: { minX: -2, minY: -2, maxX: 5, maxY: 2 },
  obstacles,
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
      type: "pcb_trace",
      pcb_trace_id: "power",
      connection_name: "POWER",
      route,
    },
  ],
});

const solve = (input: ReturnType<typeof problem>) => {
  const before = structuredClone(input);
  const solver = new PowerTraceClearanceRepairSolver({
    simpleRouteJson: input,
    traces: input.traces,
  });
  solver.solve();
  expect(solver.solved).toBe(true);
  expect(solver.failed).toBe(false);
  expect(solver.budgetLimited).toBe(false);
  expect(input).toEqual(before);
  return solver.getOutput();
};

const segments = (trace: SimplifiedPcbTrace) =>
  trace.route.flatMap((start, i) => {
    const end = trace.route[i + 1];
    return start.route_type === "wire" &&
      end?.route_type === "wire" &&
      start.layer === end.layer
      ? [{ start, end, width: start.width }]
      : [];
  });

const horizontalCopper = (trace: SimplifiedPcbTrace) =>
  segments(trace)
    .map(({ start, end, width }) => [
      Number(Math.min(start.x, end.x).toFixed(9)),
      Number(Math.max(start.x, end.x).toFixed(9)),
      Number(width.toFixed(9)),
    ])
    .sort((a, b) => a[0]! - b[0]!);

const expectNoNewTinySegments = (
  before: SimplifiedPcbTrace,
  after: SimplifiedPcbTrace,
) => {
  for (const { start, end } of segments(after)) {
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    if (length === 0 || length >= 0.001 - 1e-12) continue;
    expect(
      segments(before).some(
        (original) =>
          original.start.x === start.x &&
          original.start.y === start.y &&
          original.end.x === end.x &&
          original.end.y === end.y,
      ),
    ).toBe(true);
  }
};

for (const reverse of [false, true]) {
  test(`uses one exact pad boundary with segment-owned widths (${reverse ? "entry" : "exit"})`, () => {
    const input = problem(reverse ? [wire(3), wire(0)] : [wire(0), wire(3)]);
    const output = solve(input);
    expect(horizontalCopper(output[0]!)).toEqual([
      [0, 0.5, 0.3],
      [0.5, 3, 0.5],
    ]);
    expect(output[0]!.route).toHaveLength(3);
    expectNoNewTinySegments(input.traces[0]!, output[0]!);
    expect(solve({ ...input, traces: output })).toEqual(output);
  });

  test(`keeps distinct pad neck widths and a wide middle (${reverse ? "reverse" : "forward"})`, () => {
    const input = problem(reverse ? [wire(3), wire(0)] : [wire(0), wire(3)], [
      pad(0),
      pad(3, 1, 0.4),
    ]);
    const output = solve(input);
    expect(horizontalCopper(output[0]!)).toEqual([
      [0, 0.5, 0.3],
      [0.5, 2.5, 0.5],
      [2.5, 3, 0.4],
    ]);
    expectNoNewTinySegments(input.traces[0]!, output[0]!);
    expect(solve({ ...input, traces: output })).toEqual(output);
  });
}

for (const angle of [30, 120, 225]) {
  for (const reverse of [false, true]) {
    test(`keeps outside copper wide at a rotated pad edge (${angle} degrees, ${reverse ? "entry" : "exit"})`, () => {
      const radians = (angle * Math.PI) / 180;
      const endpoint = wire(3 * Math.cos(radians), 0.5, 3 * Math.sin(radians));
      const input = problem(
        reverse ? [endpoint, wire(0)] : [wire(0), endpoint],
      );
      input.obstacles[0]!.ccwRotationDegrees = angle;
      const output = solve(input);
      expect(
        segments(output[0]!)
          .map(({ start, end, width }) => [
            Number(
              Math.min(
                Math.hypot(start.x, start.y),
                Math.hypot(end.x, end.y),
              ).toFixed(9),
            ),
            Number(
              Math.max(
                Math.hypot(start.x, start.y),
                Math.hypot(end.x, end.y),
              ).toFixed(9),
            ),
            Number(width.toFixed(9)),
          ])
          .sort((a, b) => a[0]! - b[0]!),
      ).toEqual([
        [0, 0.5, 0.3],
        [0.5, 3, 0.5],
      ]);
      expectNoNewTinySegments(input.traces[0]!, output[0]!);
      expect(solve({ ...input, traces: output })).toEqual(output);
    });
  }
}

test("a pad edge at an existing point does not repeatedly neck its outgoing segment", () => {
  const input = problem([wire(0, 0.3), wire(0.5), wire(3, 0.9)]);
  const output = solve(input);
  expect(output).toEqual(input.traces);
});

test("an inserted boundary never creates a sub-micron fragment beside an existing point", () => {
  for (const reverse of [false, true]) {
    const route = reverse
      ? [wire(3), wire(0.5005), wire(0)]
      : [wire(0), wire(0.5005), wire(3)];
    const input = problem(route);
    const output = solve(input);
    expectNoNewTinySegments(input.traces[0]!, output[0]!);
    expect(output[0]!.route.map((p) => "x" in p && p.x)).toEqual(
      route.map((p) => "x" in p && p.x),
    );
    const neck = segments(output[0]!).find(
      ({ start, end }) => Math.min(start.x, end.x) === 0,
    );
    expect(neck!.width).toBeCloseTo(0.3, 9);
  }
});

test("does not create a tiny wide segment between nearly touching pads", () => {
  const input = problem([wire(0), wire(1.0005)], [pad(0), pad(1.0005, 1, 0.4)]);
  const output = solve(input);
  expectNoNewTinySegments(input.traces[0]!, output[0]!);
  for (const { width } of segments(output[0]!)) {
    expect(width).toBeLessThanOrEqual(0.4 + 1e-9);
  }
  expect(solve({ ...input, traces: output })).toEqual(output);
});

test("preserves pre-existing sub-micron segment geometry", () => {
  const input = problem([wire(0, 0.3), wire(0.0002), wire(3)]);
  const output = solve(input);
  expect(output[0]!.route.slice(0, 2).map((p) => "x" in p && p.x)).toEqual([
    0, 0.0002,
  ]);
  expectNoNewTinySegments(input.traces[0]!, output[0]!);
});

test("a foreign trace beside the narrow pad stays clear in either route direction", () => {
  for (const reverse of [false, true]) {
    const input = problem(reverse ? [wire(3), wire(0)] : [wire(0), wire(3)]);
    const signal: SimplifiedPcbTrace = {
      type: "pcb_trace",
      pcb_trace_id: "signal",
      connection_name: "SIGNAL",
      route: [wire(-0.2, 0.1, 0.32), wire(0.1, 0.1, 0.32)],
    };
    input.traces.push(signal);
    const output = solve(input);
    const index = new SpatialObstacleIndex(input, output);
    for (const { start, end, width } of segments(output[0]!)) {
      const foreign = index
        .findCollisions({
          start,
          end,
          width,
          layer: start.layer,
          connectionNames: ["POWER"],
          ignoreTraceIndex: 0,
        })
        .filter(
          (collision) =>
            collision.kind === "trace" && collision.traceIndex === 1,
        );
      expect(foreign).toEqual([]);
    }
    expect(output[1]).toEqual(signal);
    expectNoNewTinySegments(input.traces[0]!, output[0]!);
  }
});

for (const reverse of [false, true]) {
  for (const blocked of [false, true]) {
    test(`restores only clear outside copper beside a via (${reverse ? "entry" : "exit"}, ${blocked ? "blocked" : "clear"})`, () => {
      const bottom = (x: number, width: number): WireRoutePoint => ({
        ...wire(x, width),
        layer: "bottom",
      });
      const route: SimplifiedPcbTrace["route"] = reverse
        ? [
            bottom(3, 0.7),
            bottom(2, 0.2),
            {
              route_type: "via",
              x: 2,
              y: 0,
              from_layer: "bottom",
              to_layer: "top",
            },
            wire(2, 0.3),
            wire(0, 0.9),
          ]
        : [
            wire(0, 0.3),
            wire(2, 0.2),
            {
              route_type: "via",
              x: 2,
              y: 0,
              from_layer: "top",
              to_layer: "bottom",
            },
            bottom(2, 0.7),
            bottom(3, 0.8),
          ];
      const input = problem(route);
      if (blocked) {
        input.obstacles.push({
          ...pad(1, 0.3, 0.1),
          center: { x: 1, y: 0.32 },
          connectedTo: ["pcb_smtpad_signal", "SIGNAL"],
        });
      }
      const output = solve(input);
      const topSegments = segments(output[0]!).filter(
        ({ start }) => start.layer === "top",
      );
      if (blocked) {
        expect(topSegments.every(({ width }) => width === 0.3)).toBe(true);
      } else {
        expect(
          topSegments
            .map(({ start, end, width }) => [
              Math.min(start.x, end.x),
              Math.max(start.x, end.x),
              width,
            ])
            .sort((a, b) => a[0]! - b[0]!),
        ).toEqual([
          [0, 0.5, 0.3],
          [0.5, 2, 0.5],
        ]);
      }
      expect(
        segments(output[0]!).find(({ start }) => start.layer === "bottom")!
          .width,
      ).toBe(0.7);
      expect(output[0]!.route.at(-1)).toEqual(route.at(-1));
      expectNoNewTinySegments(input.traces[0]!, output[0]!);
      expect(solve({ ...input, traces: output })).toEqual(output);
    });
  }
}
