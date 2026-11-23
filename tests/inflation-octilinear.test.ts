import { expect, test } from "bun:test";
import { simplifiedCases } from "../fixtures/simplified-cases";
import { LocalTraceInflationSolver } from "../src/LocalTraceInflationSolver";
import { isOctilinearSegment } from "../src/octilinear";

test("inflation keeps displaced signal paths on straight and 45-degree headings", (): void => {
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
  solver.solve();
  expect(solver.solved).toBe(true);
  const output = solver.getOutput();
  expect(output).not.toBeNull();
  const trace = output!.traces[output!.pushedTraceIndex]!;
  expect(trace.route[0]).toEqual(problem.traces[1]!.route[0]);
  expect(trace.route.at(-1)).toEqual(problem.traces[1]!.route.at(-1));
  for (let index = 1; index < trace.route.length; index++) {
    const start = trace.route[index - 1]!,
      end = trace.route[index]!;
    if (
      start.route_type === "wire" &&
      end.route_type === "wire" &&
      start.layer === end.layer
    ) {
      expect(isOctilinearSegment(start, end)).toBe(true);
    }
  }
});
