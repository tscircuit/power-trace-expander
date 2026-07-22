import { expect, setDefaultTimeout, test } from "bun:test";
import "bun-match-svg";
import "graphics-debug/matcher";
import type { SimpleRouteJson } from "@tscircuit/core";
import rp2040DualMotorProblem from "../fixtures/rp2040-dual-motor/input.json";
import { PowerTraceExpanderSolver } from "../src";
import { countNonOctilinearSegments } from "../src/octilinear";
import { UPPER_P_MOTOR_A_CONNECTION } from "../fixtures/rp2040-dual-motor/create-upper-p-motor-a-problem";
import { getTraceWidthMetrics } from "./helpers/getTraceWidthMetrics";

setDefaultTimeout(60_000);

test("RP2040 Dual Motor SRJ substantially expands routed trace widths", async () => {
  const problem = structuredClone(
    rp2040DualMotorProblem,
  ) as unknown as SimpleRouteJson;
  const before = getTraceWidthMetrics(problem, problem.traces ?? []);
  const conservativeBefore = getTraceWidthMetrics(
    problem,
    problem.traces ?? [],
    { segmentWidthSemantics: "endpoint-minimum" },
  );
  const solver = new PowerTraceExpanderSolver(problem);
  const startTime = performance.now();

  solver.solve();

  const runtimeMs = performance.now() - startTime;
  const after = getTraceWidthMetrics(problem, solver.getOutput());
  const conservativeAfter = getTraceWidthMetrics(problem, solver.getOutput(), {
    segmentWidthSemantics: "endpoint-minimum",
  });
  const powerBefore = before.get(1)!;
  const powerAfter = after.get(1)!;
  const conservativePowerBefore = conservativeBefore.get(1)!;
  const conservativePowerAfter = conservativeAfter.get(1)!;
  const logicBefore = before.get(0.25)!;
  const logicAfter = after.get(0.25)!;
  const upperMotorATrace = solver
    .getOutput()
    .find((trace) => trace.connection_name === UPPER_P_MOTOR_A_CONNECTION)!;
  const usbVbusTransitionTrace = solver
    .getOutput()
    .find(
      (trace) =>
        trace.connection_name === "source_trace_109" &&
        trace.pcb_trace_id.endsWith("_mst4_0"),
    );
  const reversibleUsbBoundary = usbVbusTransitionTrace?.route.find(
    (point) =>
      point.route_type === "wire" &&
      Math.abs(point.x - 29.399811762347507) < 1e-6 &&
      Math.abs(point.y - 30.091158626533893) < 1e-6,
  );
  let upperMotorALength = 0;
  let upperMotorANominalLength = 0;
  let upperMotorAWidthArea = 0;
  let upperMotorABottomLength = 0;
  for (let index = 0; index < upperMotorATrace.route.length - 1; index++) {
    const start = upperMotorATrace.route[index];
    const end = upperMotorATrace.route[index + 1];
    if (
      start?.route_type !== "wire" ||
      end?.route_type !== "wire" ||
      start.layer !== end.layer
    ) {
      continue;
    }
    const segmentLength = Math.hypot(end.x - start.x, end.y - start.y);
    const conservativeWidth = Math.min(start.width, end.width);
    upperMotorALength += segmentLength;
    upperMotorAWidthArea += segmentLength * conservativeWidth;
    if (conservativeWidth >= 1 - 1e-6) {
      upperMotorANominalLength += segmentLength;
    }
    if (start.layer === "bottom") upperMotorABottomLength += segmentLength;
  }

  expect(solver.solved).toBe(true);
  expect(solver.failed).toBe(false);
  expect(powerBefore.nominalCoverage).toBeLessThan(0.02);
  expect(powerAfter.nominalCoverage).toBeGreaterThan(0.86);
  expect(powerAfter.averageWidth).toBeGreaterThan(0.938);
  expect(powerAfter.minimumWidth).toBeGreaterThanOrEqual(0.15);
  expect(powerAfter.p05Width).toBeGreaterThanOrEqual(0.375);
  expect(powerAfter.p10Width).toBeGreaterThanOrEqual(0.7);
  expect(powerAfter.coverageByFraction[0.5]).toBeGreaterThan(0.93);
  expect(powerAfter.coverageByFraction[0.875]).toBeGreaterThan(0.88);
  expect(powerAfter.normalizedWidthDeficit).toBeLessThan(0.065);
  expect(powerAfter.longestBelowHalfNominalRun).toBeLessThan(4);
  expect(powerAfter.longestUnderNominalRun).toBeLessThan(8.6);
  expect(powerAfter.longestBelowHalfNominalRun).toBeLessThan(
    powerBefore.longestBelowHalfNominalRun / 7,
  );
  expect(powerAfter.totalLength / powerBefore.totalLength).toBeLessThan(1.12);
  expect(conservativePowerAfter.nominalCoverage).toBeGreaterThan(0.85);
  expect(conservativePowerAfter.averageWidth).toBeGreaterThan(0.934);
  expect(conservativePowerAfter.normalizedWidthDeficit).toBeLessThan(0.066);
  expect(conservativePowerAfter.normalizedWidthDeficit).toBeLessThan(
    conservativePowerBefore.normalizedWidthDeficit / 7,
  );
  expect(logicAfter.nominalCoverage).toBeGreaterThan(0.993);
  expect(logicAfter.nominalCoverage).toBeGreaterThan(
    logicBefore.nominalCoverage * 2,
  );
  expect(solver.reroutedSegmentCount).toBeGreaterThan(45);
  expect(solver.pushedTraceCount).toBeGreaterThan(0);
  expect(solver.elasticPushedTraceCount).toBeGreaterThan(0);
  expect(solver.completedPassCount).toBeGreaterThanOrEqual(2);
  expect(solver.completedPassCount).toBeLessThanOrEqual(4);
  expect(solver.plateauReached).toBe(true);
  expect(solver.lastNormalizedWidthDeficitGain).toBeLessThan(0.001);
  expect(solver.normalizedWidthDeficitGainByPass[0]).toBeGreaterThan(0.5);
  expect(solver.normalizedWidthDeficitGainByPass.at(-1)).toBeLessThan(0.001);
  expect(solver.iterations).toBeLessThan(4_100_000);
  expect(solver.attemptedGridCount).toBeLessThan(16_000);
  expect(solver.attemptedLayerGridCount).toBeLessThan(60);
  expect(solver.layerReroutedTraceCount).toBeGreaterThan(0);
  expect(solver.insertedViaCount).toBeGreaterThan(0);
  expect(solver.removedViaPairCount).toBeGreaterThanOrEqual(6);
  expect(solver.removedViaCount).toBeGreaterThanOrEqual(12);
  expect(solver.simplifiedPathCount).toBeGreaterThan(55);
  expect(solver.normalizedSegmentCount).toBeGreaterThanOrEqual(80);
  expect(solver.cleanupClearanceShoveCount).toBeGreaterThan(0);
  // Core may reverse this route when it maps the solver result back to the
  // source trace. Cleanup must preserve the narrow boundary width so the
  // reversed segment cannot become a 1 mm USB fanout collision.
  expect(
    reversibleUsbBoundary?.route_type === "wire"
      ? reversibleUsbBoundary.width
      : undefined,
  ).toBe(0.375);
  const remainingNonOctilinearPowerSegments = solver
    .getOutput()
    .filter((trace) => {
      const connection = problem.connections.find((candidate) =>
        [
          candidate.name,
          candidate.source_trace_id,
          candidate.rootConnectionName,
          ...(candidate.mergedConnectionNames ?? []),
        ]
          .filter(Boolean)
          .some((name) =>
            [
              trace.connection_name,
              trace.source_trace_id,
              trace.rootConnectionName,
              ...(trace.mergedConnectionNames ?? []),
            ].includes(name as string),
          ),
      );
      return (connection?.nominalTraceWidth ?? connection?.width ?? 0) >= 0.5;
    })
    .reduce((count, trace) => {
      for (let index = 0; index < trace.route.length - 1; index++) {
        const start = trace.route[index];
        const end = trace.route[index + 1];
        if (
          start?.route_type === "wire" &&
          end?.route_type === "wire" &&
          start.layer === end.layer
        ) {
          count += countNonOctilinearSegments([start, end]);
        }
      }
      return count;
    }, 0);
  expect(remainingNonOctilinearPowerSegments).toBeLessThan(55);
  expect(
    upperMotorATrace.route.filter((point) => point.route_type === "via"),
  ).toHaveLength(2);
  expect(upperMotorABottomLength).toBeGreaterThan(10);
  expect(upperMotorANominalLength / upperMotorALength).toBeGreaterThan(0.99);
  expect(upperMotorAWidthArea / upperMotorALength).toBeGreaterThan(0.995);
  expect(runtimeMs).toBeLessThan(20_000);

  await expect(solver.visualize()).toMatchGraphicsSvg(import.meta.path);
});
