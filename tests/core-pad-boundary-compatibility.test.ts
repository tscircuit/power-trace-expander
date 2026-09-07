import { expect, test } from "bun:test";
import { resolve } from "node:path";
import type {
  SimplifiedPcbTrace as CorePcbTrace,
  SimpleRouteJson as CoreSimpleRouteJson,
} from "@tscircuit/core";
import { SolverAutorouterAdapter } from "../src/createPowerTraceExpanderAutorouter";
import { PowerTraceClearanceRepairSolver } from "../src/PowerTraceClearanceRepairSolver";
import type {
  SimpleRouteJson,
  SimplifiedPcbTrace,
  WireRoutePoint,
} from "../src/types";

/**
 * Opt-in integration with the real public Core API. Core 0.0.1737 omits several
 * runtime imports from its package dependencies, so use a separate installation
 * without changing this repository's dependency graph.
 *
 * Create work/core-compat/package.json containing:
 *   {"private":true,"type":"module"}
 * Then, from the repository root:
 *   bun add --cwd work/core-compat --exact --ignore-scripts @tscircuit/core@0.0.1737 @tscircuit/circuit-json-util@0.0.106 react@19.1.0 calculate-elbow@0.0.12 @tscircuit/infer-cable-insertion-point@0.0.4 @tscircuit/copper-pour-solver@0.0.49 @tscircuit/schematic-trace-solver@0.0.141 @tscircuit/miniflex@0.0.4 minicssgrid@0.0.9 spicey@0.0.14 connectivity-map@1.0.0 @tscircuit/soup-util@0.0.41
 *   TSCIRCUIT_CORE_COMPAT_DIR=work/core-compat bun test tests/core-pad-boundary-compatibility.test.ts
 * In PowerShell, set $env:TSCIRCUIT_CORE_COMPAT_DIR='work/core-compat' first.
 *
 * The directory is used only to resolve the public Core and React packages.
 * An explicitly configured missing or incompatible runtime fails this test.
 */
const coreRuntimeDirectory = process.env.TSCIRCUIT_CORE_COMPAT_DIR;

const wirePoints = (trace: SimplifiedPcbTrace): WireRoutePoint[] => {
  expect(trace.route.every((point) => point.route_type === "wire")).toBe(true);
  return trace.route as WireRoutePoint[];
};

const physicalCopper = (trace: SimplifiedPcbTrace) => {
  const route = wirePoints(trace);
  return route
    .slice(0, -1)
    .map((start, index) => {
      const end = route[index + 1];
      expect(start.layer).toBe(end.layer);
      expect(start.y).toBe(0);
      expect(end.y).toBe(0);
      expect(
        Math.hypot(end.x - start.x, end.y - start.y),
      ).toBeGreaterThanOrEqual(0.001);
      return [Math.min(start.x, end.x), Math.max(start.x, end.x), start.width];
    })
    .sort((left, right) => left[0] - right[0]);
};

test.skipIf(!coreRuntimeDirectory)(
  "Core preserves repaired pad copper when it orients either solver direction",
  async () => {
    if (!coreRuntimeDirectory)
      throw new Error("Missing Core runtime directory");
    const runtimeDirectory = resolve(coreRuntimeDirectory);
    const { Circuit } = (await import(
      Bun.resolveSync("@tscircuit/core", runtimeDirectory)
    )) as typeof import("@tscircuit/core");
    const { createElement: h } = (await import(
      Bun.resolveSync("react", runtimeDirectory)
    )) as typeof import("react");
    const expectedCopper = [
      [-1.5, -1, 0.3],
      [-1, 1, 0.5],
      [1, 1.5, 0.4],
    ];
    const circuitCopperByDirection: number[][][] = [];

    for (const reverse of [false, true]) {
      let suppliedTrace: SimplifiedPcbTrace | undefined;
      let sourceTraceId: string | undefined;
      let sourcePortId: string | undefined;
      let targetPortId: string | undefined;
      let autorouterCalls = 0;
      const circuit = new Circuit();
      circuit.schematicDisabled = true;
      const footprint = (height: number) =>
        h(
          "footprint",
          {},
          h("smtpad", {
            portHints: ["pin1"],
            shape: "rect",
            pcbX: 0,
            pcbY: 0,
            width: 1,
            height,
          }),
        );

      circuit.add(
        h(
          "board",
          {
            width: 8,
            height: 4,
            autorouter: {
              local: true,
              groupMode: "subcircuit",
              algorithmFn: async (input: CoreSimpleRouteJson) => {
                autorouterCalls++;
                expect(input.connections).toHaveLength(1);
                const connection = input.connections[0];
                expect(connection.pointsToConnect).toHaveLength(2);
                sourceTraceId = connection.source_trace_id ?? connection.name;
                sourcePortId = connection.pointsToConnect[0].pcb_port_id;
                targetPortId = connection.pointsToConnect[1].pcb_port_id;
                const points = [...connection.pointsToConnect];
                if (reverse) points.reverse();
                const trace: SimplifiedPcbTrace = {
                  type: "pcb_trace",
                  pcb_trace_id: "pad_boundary_compatibility",
                  connection_name: connection.name,
                  source_trace_id: sourceTraceId,
                  route: points.map((point) => ({
                    route_type: "wire",
                    x: point.x,
                    y: point.y,
                    layer: point.layer,
                    width: 0.5,
                  })),
                };
                const repair = new PowerTraceClearanceRepairSolver({
                  simpleRouteJson: input as unknown as SimpleRouteJson,
                  traces: [trace],
                });
                return new SolverAutorouterAdapter({
                  input,
                  solver: repair,
                  getOutput: (solver) => {
                    expect(solver.solved).toBe(true);
                    expect(solver.failed).toBe(false);
                    expect(solver.budgetLimited).toBe(false);
                    expect(solver.repairedPadNeckSegmentCount).toBeGreaterThan(
                      0,
                    );
                    expect(solver.getOutput()).toHaveLength(1);
                    suppliedTrace = structuredClone(solver.getOutput()[0]);
                    return solver.getOutput() as CorePcbTrace[];
                  },
                  getPhase: () => "pad-boundary-compatibility",
                });
              },
            },
          },
          h("chip", {
            name: "P1",
            pcbX: -1.5,
            pcbY: 0,
            pinLabels: { pin1: ["POWER"] },
            footprint: footprint(0.3),
          }),
          h("chip", {
            name: "P2",
            pcbX: 1.5,
            pcbY: 0,
            pinLabels: { pin1: ["POWER"] },
            footprint: footprint(0.4),
          }),
          h("trace", {
            from: ".P1 > .pin1",
            to: ".P2 > .pin1",
            width: 0.5,
          }),
        ),
      );

      await circuit.renderUntilSettled();
      expect(autorouterCalls).toBe(1);
      if (!suppliedTrace)
        throw new Error("Core did not consume repaired traces");
      const suppliedRoute = wirePoints(suppliedTrace);
      expect(suppliedRoute).toHaveLength(4);
      expect(suppliedRoute[0].x).toBe(reverse ? 1.5 : -1.5);
      expect(physicalCopper(suppliedTrace)).toEqual(expectedCopper);

      const circuitJson = circuit.getCircuitJson();
      expect(circuitJson.filter((item) => item.type.endsWith("error"))).toEqual(
        [],
      );
      const circuitTraces = circuitJson.filter(
        (item) => item.type === "pcb_trace",
      );
      expect(circuitTraces).toHaveLength(1);
      const output = circuitTraces[0] as unknown as SimplifiedPcbTrace;
      const route = wirePoints(output);
      expect(route).toHaveLength(4);
      // In the reverse case these endpoints prove Core actually reoriented
      // the supplied route; physical widths are measured from their new owners.
      expect(route[0].x).toBe(-1.5);
      expect(route[route.length - 1].x).toBe(1.5);
      expect(output.pcb_trace_id).toBe(suppliedTrace.pcb_trace_id);
      expect(output.connection_name).toBe(suppliedTrace.connection_name);
      expect(output.source_trace_id).toBe(sourceTraceId);
      expect(sourcePortId).toBeDefined();
      expect(targetPortId).toBeDefined();
      expect(route[0].start_pcb_port_id).toBe(sourcePortId);
      expect(route[route.length - 1].end_pcb_port_id).toBe(targetPortId);
      const copper = physicalCopper(output);
      expect(copper).toEqual(expectedCopper);
      circuitCopperByDirection.push(copper);
    }

    expect(circuitCopperByDirection[0]).toEqual(circuitCopperByDirection[1]);
  },
);
