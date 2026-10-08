import { expect, test } from "bun:test";
import "bun-match-svg";
import { PowerTraceExpanderSolver, SpatialObstacleIndex } from "../src";
import type { SimpleRouteJson } from "../src/types";
import {
  aliasIndexSnapshot,
  drawAliasIndex,
} from "./helpers/alias-index-snapshot";

test("power expansion through aliased pads keeps clearance from unrelated copper", async (): Promise<void> => {
  // Imported pads can identify POWER only by a pcb_port_id plus many aliases.
  // Sharing their resolved set must preserve these connections without making
  // the unrelated center pad disappear from power-trace collision checks.
  const input: SimpleRouteJson = {
    layerCount: 1,
    minTraceWidth: 0.15,
    nominalTraceWidth: 0.8,
    minTraceToPadEdgeClearance: 0.15,
    bounds: { minX: -6, maxX: 6, minY: -4, maxY: 3 },
    connections: [
      {
        name: "POWER",
        source_trace_id: "imported-power",
        nominalTraceWidth: 0.8,
        pointsToConnect: [
          { x: -4, y: -1.05, layer: "top", pcb_port_id: "power-left" },
          { x: 4, y: -1.05, layer: "top", pcb_port_id: "power-right" },
        ],
      },
    ],
    obstacles: [
      ...[-4, 4].map((x, padIndex) => ({
        type: "rect" as const,
        center: { x, y: -1.05 },
        width: 1.2,
        height: 1.6,
        layers: ["top"],
        connectedTo: [
          `pcb_smtpad_power_${padIndex}`,
          padIndex === 0 ? "power-left" : "power-right",
          ...Array.from(
            { length: 126 },
            (_, index) => `pad-${padIndex}-alias-${index}`,
          ),
        ],
      })),
      {
        type: "rect",
        center: { x: 0, y: 0 },
        width: 2,
        height: 1.6,
        layers: ["top"],
        connectedTo: ["pcb_smtpad_signal", "SIGNAL"],
      },
    ],
    traces: [
      {
        type: "pcb_trace",
        pcb_trace_id: "power-escape",
        connection_name: "POWER",
        source_trace_id: "imported-power",
        route: [-4, -1.2, 1.2, 4].map((x) => ({
          route_type: "wire",
          x,
          y: -1.05,
          width: 0.15,
          layer: "top",
        })),
      },
    ],
  };
  const original = structuredClone(input);
  const initialIndex = new SpatialObstacleIndex(input, input.traces!);
  const query = {
    start: { x: -4, y: -1.05 },
    end: { x: 4, y: -1.05 },
    layer: "top",
    width: 0.15,
    connectionNames: ["POWER"],
    ignoreTraceIndex: 0,
  };
  expect(initialIndex.collides(query)).toBe(false);
  expect(initialIndex.collides({ ...query, width: 0.8 })).toBe(true);

  const solver = new PowerTraceExpanderSolver(input, { allowNewVias: false });
  solver.solve();
  expect(solver.solved).toBe(true);
  expect(solver.failed).toBe(false);
  expect(solver.reroutedSegmentCount).toBeGreaterThan(0);
  const output = solver.getOutput();
  expect(output).toHaveLength(1);
  expect(output[0]!.route[0]).toMatchObject({ x: -4, y: -1.05, layer: "top" });
  expect(output[0]!.route.at(-1)).toMatchObject({
    x: 4,
    y: -1.05,
    layer: "top",
  });
  const finalIndex = new SpatialObstacleIndex(input, output);
  for (let index = 1; index < output[0]!.route.length; index++) {
    const start = output[0]!.route[index - 1]!;
    const end = output[0]!.route[index]!;
    expect(start.route_type).toBe("wire");
    expect(end.route_type).toBe("wire");
    if (start.route_type !== "wire" || end.route_type !== "wire") continue;
    expect(start.width).toBeGreaterThanOrEqual(0.8);
    expect(
      finalIndex.collides({ ...query, start, end, width: start.width }),
    ).toBe(false);
  }

  // Removing redundant pad aliases must not change any routed point or width.
  const sparseInput = structuredClone(input);
  for (const pad of sparseInput.obstacles.slice(0, 2))
    pad.connectedTo.splice(2);
  const sparseSolver = new PowerTraceExpanderSolver(sparseInput, {
    allowNewVias: false,
  });
  sparseSolver.solve();
  expect(sparseSolver.solved).toBe(true);
  expect(sparseSolver.failed).toBe(false);
  expect(output).toEqual(sparseSolver.getOutput());
  expect(input).toEqual(original);

  const svg = aliasIndexSnapshot(
    [
      drawAliasIndex({
        input,
        obstacleColors: [
          "rgba(37,99,235,0.15)",
          "rgba(37,99,235,0.15)",
          "rgba(234,88,12,0.20)",
        ],
        notes: [
          "0.15 mm input fits below SIGNAL",
          "Blue pads: 128 aliases each; orange: SIGNAL",
        ],
      }),
      drawAliasIndex({
        input,
        traces: output,
        obstacleColors: [
          "rgba(37,99,235,0.15)",
          "rgba(37,99,235,0.15)",
          "rgba(234,88,12,0.20)",
        ],
        notes: [
          "0.80 mm power route detours around SIGNAL",
          "Identical output with 2 or 128 aliases per pad",
        ],
      }),
    ],
    [
      "Before expansion: valid narrow trace",
      "After expansion: same net, preserved clearance",
    ],
  );
  await expect(svg).toMatchSvgSnapshot(import.meta.path);
});
