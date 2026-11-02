import { expect, test } from "bun:test";
import { simplifiedCases } from "../fixtures/simplified-cases";
import { LocalTraceInflationSolver } from "../src/LocalTraceInflationSolver";

test("inflation snapshots stay isolated when a route is replaced", (): void => {
  const problem = structuredClone(simplifiedCases.inflationPushesSignal);
  const solver = new LocalTraceInflationSolver({
    simpleRouteJson: problem,
    traces: problem.traces,
    powerTraceIndex: 0,
    nominalPowerWidth: 0.8,
    corridor: [
      { start: { x: -4, y: 0 }, end: { x: 4, y: 0 }, layer: "top", width: 0.8 },
    ],
    maxRerouteLength: 10,
  });
  const original = structuredClone(solver.inputProblem);
  const inputPoint = problem.traces[0]!.route[0]!;
  if (inputPoint.route_type !== "wire") throw new Error("Expected input wire");
  inputPoint.x += 100;
  solver.solve();
  expect(solver.solved).toBe(true);
  expect(solver.getOutput()?.pushedTraceIndex).toBe(1);
  expect(solver.inputProblem).toEqual(original);
  const outputPoint = solver.traces[1]!.route[0]!;
  if (outputPoint.route_type !== "wire")
    throw new Error("Expected output wire");
  outputPoint.x += 100;
  expect(solver.inputProblem).toEqual(original);
});
