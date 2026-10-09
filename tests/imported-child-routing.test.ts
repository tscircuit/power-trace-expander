import { expect, test } from "bun:test";
import "bun-match-svg";
import "graphics-debug/matcher";
import { cleanupCases } from "../fixtures/cleanup-cases";
import { simplifiedCases } from "../fixtures/simplified-cases";
import {
  measureTraceWidths,
  PowerTraceCleanupSolver,
  PowerTraceClearanceRepairSolver,
  PowerTraceExpanderSolver,
} from "../src";
import type { PowerTraceExpanderInput } from "../src/types";

const testWire = (x: number, y: number, width = 0.15) => ({
  route_type: "wire" as const,
  x,
  y,
  width,
  layer: "top" as const,
});
const wire = testWire;

test("keeps port-aliased child routing while treating it as same-net copper", async () => {
  const input = structuredClone(simplifiedCases.straightClear);
  input.connections[0]!.pointsToConnect[0] = {
    ...input.connections[0]!.pointsToConnect[0]!,
    pointId: "shared_child_port",
    pcb_port_id: "shared_child_port",
  };
  const childTrace = {
    type: "pcb_trace" as const,
    pcb_trace_id: "child-power-alias",
    connection_name: "CHILD_POWER_ALIAS",
    connectsTo: ["shared_child_port", "child_internal_port"],
    route: [
      {
        route_type: "wire" as const,
        x: -1,
        y: 1,
        width: 0.15,
        layer: "top" as const,
      },
      {
        route_type: "wire" as const,
        x: -0.5,
        y: 1.4,
        width: 0.15,
        layer: "top" as const,
      },
      {
        route_type: "wire" as const,
        x: 0,
        y: 1,
        width: 0.15,
        layer: "top" as const,
      },
      {
        route_type: "wire" as const,
        x: 0.5,
        y: 1.4,
        width: 0.15,
        layer: "top" as const,
      },
      {
        route_type: "wire" as const,
        x: 1,
        y: 1,
        width: 0.15,
        layer: "top" as const,
      },
    ],
  };
  input.traces!.push(childTrace);
  const originalChildRoute = structuredClone(childTrace.route);
  const solver = new PowerTraceExpanderSolver(input);

  solver.solve();

  expect(solver.solved).toBe(true);
  expect(solver.getOutput()[1]!.route).toEqual(originalChildRoute);
  expect(
    (solver.stats as { cleanupMutatedTraceIndices: number[] })
      .cleanupMutatedTraceIndices,
  ).not.toContain(1);
  expect(solver.stats).toMatchObject({ immutableTraceMutationIds: [] });
  await expect({
    ...solver.visualize(),
    title: "Same electrical net does not grant ownership of child routing",
    texts: [
      {
        x: 0,
        y: -0.9,
        text: "Board-owned power trace may widen",
        fontSize: 0.2,
      },
      {
        x: 0,
        y: 2,
        text: "Imported child detour and private terminal stay unchanged",
        fontSize: 0.2,
      },
    ],
  }).toMatchGraphicsSvg(import.meta.path, {
    svgName: "preserved-child-branch",
  });
});

test("final acceptance rolls back an opaque child mutation", () => {
  const input = structuredClone(simplifiedCases.straightClear);
  input.traces!.push({
    type: "pcb_trace",
    pcb_trace_id: "opaque-child",
    connection_name: "CHILD",
    connectsTo: ["child-left", "child-right"],
    route: [testWire(-1, 2), testWire(0, 2.5), testWire(1, 2)],
  });
  const solver = new PowerTraceExpanderSolver(input);
  const original = structuredClone(solver.getOutput());
  const candidate = structuredClone(solver.traces);
  candidate[1]!.route = [testWire(-1, 2), testWire(1, 2)];
  const internalSolver = solver as unknown as {
    acceptOwnershipCheckpoint: (
      traces: typeof candidate,
      phase: "final",
    ) => boolean;
  };

  expect(internalSolver.acceptOwnershipCheckpoint(candidate, "final")).toBe(
    false,
  );
  expect(solver.getOutput()).toEqual(original);
  expect(solver.immutableTraceMutationIds).toEqual(["opaque-child"]);
  expect(solver.immutableSafetyRollbackCount).toBe(1);
  expect(solver.immutableSafetyRollbackPhases).toEqual(["final"]);
  solver.tryFinalAcceptance();
  expect(solver.stats).toMatchObject({
    completionReason: "immutable_safety_rollback",
    immutableSafetyRollbackCount: 1,
    resultStatus: "best_effort",
  });
});

test("keeps an unowned child blocker immutable during local inflation", () => {
  const input = structuredClone(simplifiedCases.inflationPushesSignal);
  input.connections = input.connections.filter(
    (connection) => connection.name !== "SIGNAL",
  );
  const childTrace = input.traces?.[1];
  if (!childTrace) throw new Error("Expected a blocking child trace");
  childTrace.connection_name = "CHILD_SIGNAL";
  const originalChildRoute = structuredClone(childTrace.route);

  const solver = new PowerTraceExpanderSolver(input);
  solver.solve();

  expect(solver.solved).toBe(true);
  expect(solver.getOutput()[1]?.route).toEqual(originalChildRoute);
  expect(solver.pushedTraceCount).toBe(0);
  expect(solver.immutableSafetyRollbackCount).toBe(0);
});

test("targeted mode can move and final-repair an owned nearby blocker", () => {
  const input = structuredClone(simplifiedCases.inflationPushesSignal);
  const originalSignalRoute = structuredClone(input.traces?.[1]?.route);
  const solver = new PowerTraceExpanderSolver(input, {
    onlyConnectionNames: ["POWER"],
  });

  solver.solve();

  expect(solver.solved).toBe(true);
  expect(solver.pushedTraceCount).toBeGreaterThan(0);
  expect(solver.getOutput()[1]?.route).not.toEqual(originalSignalRoute);
  expect(solver.stats.expansionPushedTraceIndices).toContain(1);
  expect(solver.unresolvedSegmentCount).toBe(0);
});

test("via repair respects selected trace indices", () => {
  const problem = structuredClone(cleanupCases.routedViaInConnectedPad);
  problem.traces.push({
    type: "pcb_trace",
    pcb_trace_id: "selected-clear-trace",
    connection_name: "LOCAL_ONLY",
    route: [
      {
        route_type: "wire",
        x: -4,
        y: 3,
        width: 0.15,
        layer: "top",
      },
      {
        route_type: "wire",
        x: 4,
        y: 3,
        width: 0.15,
        layer: "top",
      },
    ],
  });
  const unselectedViaTrace = structuredClone(problem.traces[0]);
  const solver = new PowerTraceCleanupSolver({
    simpleRouteJson: problem,
    traces: problem.traces,
    traceIndices: [1],
  });

  solver.solve();

  expect(solver.getOutput()[0]).toEqual(unselectedViaTrace);
  expect(solver.stats.relocatedViaCount).toBe(0);
});

test("preserves the caller's selected trace priority", () => {
  const problem = structuredClone(cleanupCases.routedViaInConnectedPad);
  problem.traces.push({
    type: "pcb_trace",
    pcb_trace_id: "second-trace",
    connection_name: "POWER",
    route: [
      {
        route_type: "wire",
        x: -4,
        y: 3,
        width: 0.8,
        layer: "top",
      },
      {
        route_type: "wire",
        x: 4,
        y: 3,
        width: 0.8,
        layer: "top",
      },
    ],
  });

  const solver = new PowerTraceCleanupSolver({
    simpleRouteJson: problem,
    traces: problem.traces,
    traceIndices: [1, 0, 1],
  });

  expect(solver.stats.traceIndex).toBe(1);
  expect(solver.stats.traceCount).toBe(2);
});

test("clearance repair preserves the caller's trace priority", () => {
  const problem: PowerTraceExpanderInput = {
    layerCount: 1,
    minTraceWidth: 0.15,
    bounds: { minX: -2, maxX: 2, minY: -2, maxY: 2 },
    connections: [],
    obstacles: [],
    traces: [
      {
        type: "pcb_trace",
        pcb_trace_id: "first",
        route: [wire(-1, 0, 0.2), wire(1, 0, 0.2)],
      },
      {
        type: "pcb_trace",
        pcb_trace_id: "second",
        route: [wire(-1, 1, 0.2), wire(1, 1, 0.2)],
      },
    ],
  };
  const solver = new PowerTraceClearanceRepairSolver({
    simpleRouteJson: problem,
    traces: problem.traces ?? [],
    traceIndices: [1, 0, 1],
  });

  expect(solver.stats.traceIndex).toBe(1);
  expect(solver.stats.traceCount).toBe(2);
});

test("owns traces declared through netConnectionName", () => {
  const input = structuredClone(simplifiedCases.straightClear);
  input.connections[0]!.name = "logical-connection";
  input.connections[0]!.netConnectionName = "canonical-net";
  input.connections[0]!.nominalTraceWidth = 0.8;
  input.traces![0]!.connection_name = "canonical-net";
  expect(measureTraceWidths(input, input.traces!).get(0.8)).toMatchObject({
    traceCount: 1,
    nominalCoverage: 0,
  });
  const solver = new PowerTraceExpanderSolver(input);
  solver.solve();

  expect(solver.solved).toBe(true);
  expect(
    solver
      .getOutput()[0]!
      .route.filter((point) => point.route_type === "wire")
      .every((point) => point.width === 0.8),
  ).toBe(true);
  expect(solver.stats.resultStatus).toBe("complete");
  expect(measureTraceWidths(input, solver.getOutput()).get(0.8)).toMatchObject({
    traceCount: 1,
    minimumWidth: 0.8,
    nominalCoverage: 1,
  });
});

test("rejects invalid trace selections before starting cleanup or repair", () => {
  const problem = structuredClone(cleanupCases.routedViaInConnectedPad);
  for (const traceIndex of [-1, 0.5, problem.traces.length]) {
    for (const selection of [
      "traceIndices",
      "viaRepairTraceIndices",
      "mutableTraceIndices",
    ]) {
      expect(
        () =>
          new PowerTraceCleanupSolver({
            simpleRouteJson: problem,
            traces: problem.traces,
            [selection]: [traceIndex],
          }),
      ).toThrow(RangeError);
    }
    expect(
      () =>
        new PowerTraceClearanceRepairSolver({
          simpleRouteJson: problem,
          traces: problem.traces,
          traceIndices: [traceIndex],
        }),
    ).toThrow(RangeError);
  }
});
