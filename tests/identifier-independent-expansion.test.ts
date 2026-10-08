import { expect, test } from "bun:test";
import { simplifiedCases } from "../fixtures/simplified-cases";
import { PowerTraceExpanderSolver } from "../src";
import type { PowerTraceExpanderInput } from "../src/types";

test("renaming nets, traces and port aliases does not change expansion or shoving", (): void => {
  const input: PowerTraceExpanderInput = structuredClone(
    simplifiedCases.inflationPushesSignal,
  );
  const reference = new PowerTraceExpanderSolver(input, {
    onlyConnectionNames: ["POWER"],
  });
  reference.solve();
  expect(reference.solved).toBe(true);
  expect(reference.failed).toBe(false);
  expect(reference.pushedTraceCount).toBeGreaterThan(0);
  expect(reference.expandedSegmentCount).toBeGreaterThan(0);
  expect(reference.stats.resultStatus).toBe("complete");
  const referenceRoutes = reference.getOutput().map((trace) => trace.route);

  // Width metadata selects the wide net. Neither common electrical names,
  // matching substrings, punctuation, nor object-prototype keys may select it.
  const netNames = [
    ["net-a", "net-b"],
    ["GND", "POWER"],
    ["POWER", "POWER_extra"],
    ["opaque|net:α", "opaque|net:β"],
    ["__proto__", "constructor"],
  ];
  for (const [caseIndex, names] of netNames.entries()) {
    const renamed = structuredClone(input);
    for (const [connectionIndex, connection] of renamed.connections.entries()) {
      const trace = renamed.traces![connectionIndex]!;
      const name = names[connectionIndex]!;
      const sourceId = `source|${caseIndex}:${connectionIndex}`;
      const rootName = `root/${caseIndex}/${connectionIndex}`;
      const mergedName = `alias ${caseIndex} ${connectionIndex}`;
      connection.name = name;
      connection.source_trace_id = sourceId;
      connection.rootConnectionName = rootName;
      connection.netConnectionName = name;
      connection.mergedConnectionNames = [mergedName];
      for (const [pointIndex, point] of connection.pointsToConnect.entries()) {
        point.pointId = `endpoint|${caseIndex}:${connectionIndex}:${pointIndex}`;
        point.pcb_port_id = `port/${caseIndex}/${connectionIndex}/${pointIndex}`;
      }
      trace.pcb_trace_id = `trace|${caseIndex}:${connectionIndex}`;
      trace.connection_name = name;
      trace.source_trace_id = sourceId;
      trace.rootConnectionName = rootName;
      trace.mergedConnectionNames = [mergedName];
      trace.connectsTo = connection.pointsToConnect.map(
        (point) => point.pcb_port_id!,
      );
    }
    const before = structuredClone(renamed);
    const solver = new PowerTraceExpanderSolver(renamed, {
      // Exercise target selection by an alias, not just the connection's name.
      onlyConnectionNames: [renamed.connections[0]!.source_trace_id!],
    });
    solver.solve();
    expect(solver.solved).toBe(true);
    expect(solver.failed).toBe(false);
    expect(solver.getOutput().map((trace) => trace.route)).toEqual(
      referenceRoutes,
    );
    expect(solver.iterations).toBe(reference.iterations);
    expect(solver.pushedTraceCount).toBe(reference.pushedTraceCount);
    expect(solver.expandedSegmentCount).toBe(reference.expandedSegmentCount);
    expect(solver.stats.resultStatus).toBe("complete");
    expect(solver.stats.connectivityRollbackCount).toBe(0);
    expect(solver.stats.immutableSafetyRollbackCount).toBe(0);
    expect(solver.getOutput().map((trace) => trace.connection_name)).toEqual(
      names,
    );
    expect(solver.getOutput().map((trace) => trace.pcb_trace_id)).toEqual(
      renamed.traces!.map((trace) => trace.pcb_trace_id),
    );
    expect(renamed).toEqual(before);
  }
});
