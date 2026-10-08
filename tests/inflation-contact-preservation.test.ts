import { expect, test } from "bun:test";
import { simplifiedCases } from "../fixtures/simplified-cases";
import { PowerTraceExpanderSolver } from "../src";
import { capturePhysicalConnectivity } from "../src/PhysicalConnectivityInvariant";

test("rejects an inflation push that would detach a signal from its edge pad", () => {
  const input = structuredClone(simplifiedCases.inflationPushesSignal);
  input.layerCount = 1;
  // This pad touches the signal's lower edge outside the power corridor.
  // Moving the signal upward clears POWER but silently loses this junction.
  input.obstacles.push({
    type: "rect",
    center: { x: 4.6, y: 0.45 },
    width: 0.1,
    height: 0.05,
    layers: ["top"],
    connectedTo: ["SIGNAL"],
  });
  input.connections[1]!.pointsToConnect.push({
    x: 4.6,
    y: 0.45,
    layer: "top",
  });
  const originalSignal = structuredClone(input.traces![1]!);
  const baseline = capturePhysicalConnectivity(input, input.traces!);
  expect(baseline.endpointComponents).toContainEqual(["1:0", "1:1", "1:2"]);

  const solver = new PowerTraceExpanderSolver(input);
  solver.solve();

  expect(solver.solved).toBe(true);
  expect(solver.failed).toBe(false);
  expect(solver.sameNetContactRejectionCount).toBeGreaterThan(0);
  expect(solver.pushedTraceCount).toBe(0);
  // Reject the unsafe candidate immediately instead of discarding the whole
  // expansion phase after discovering the disconnected terminal at its end.
  expect(solver.connectivityRollbackCount).toBe(0);
  expect(solver.getOutput()[1]).toEqual(originalSignal);
  expect(
    capturePhysicalConnectivity(input, solver.getOutput()).endpointComponents,
  ).toEqual(baseline.endpointComponents);
});
