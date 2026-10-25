import { expect, test } from "bun:test";
import "graphics-debug/matcher";
import inputJson from "../fixtures/rf-rc-car-motor-width/input.json";
import { PowerTraceExpanderSolver, type PowerTraceExpanderInput } from "../src";

test("RF RC car full board recovers 1 mm left-motor traces", async () => {
  const input = structuredClone(inputJson) as PowerTraceExpanderInput;
  expect(input.connections).toHaveLength(15);
  expect(input.obstacles).toHaveLength(63);
  expect(input.traces).toHaveLength(46);
  const solver = new PowerTraceExpanderSolver(input, { allowNewVias: false });
  solver.solve();

  const routedTraces = solver.getOutput();
  expect(routedTraces).toHaveLength(46);
  const beforeViaCount = input
    .traces!.flatMap((trace) => trace.route)
    .filter((point) => point.route_type === "via").length;
  const afterViaCount = routedTraces
    .flatMap((trace) => trace.route)
    .filter((point) => point.route_type === "via").length;
  expect(afterViaCount).toBeLessThanOrEqual(beforeViaCount);
  const minimumWidths = new Map(
    routedTraces.map((trace) => [
      trace.connection_name,
      Math.min(
        ...trace.route
          .filter((point) => point.route_type === "wire")
          .map((point) => point.width),
      ),
    ]),
  );
  expect(solver.solved).toBe(true);
  expect(solver.failed).toBe(false);
  expect(minimumWidths.get("source_trace_42")).toBe(1);
  expect(minimumWidths.get("source_trace_43")).toBe(1);
  expect(minimumWidths.get("source_trace_44")).toBe(1);
  expect(minimumWidths.get("source_trace_45")).toBe(1);

  await expect(solver.visualize()).toMatchGraphicsSvg(import.meta.path);
});
