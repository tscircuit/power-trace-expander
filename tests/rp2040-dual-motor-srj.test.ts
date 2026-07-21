import { expect, setDefaultTimeout, test } from "bun:test";
import "bun-match-svg";
import "graphics-debug/matcher";
import type { SimpleRouteJson } from "@tscircuit/core";
import rp2040DualMotorProblem from "../fixtures/rp2040-dual-motor/input.json";
import { PowerTraceExpanderSolver } from "../src";
import { getTraceWidthMetrics } from "./helpers/getTraceWidthMetrics";

setDefaultTimeout(60_000);

test("RP2040 Dual Motor SRJ substantially expands routed trace widths", async () => {
  const problem = structuredClone(
    rp2040DualMotorProblem,
  ) as unknown as SimpleRouteJson;
  const before = getTraceWidthMetrics(problem, problem.traces ?? []);
  const solver = new PowerTraceExpanderSolver(problem);

  solver.solve();

  const after = getTraceWidthMetrics(problem, solver.getOutput());
  const powerBefore = before.get(1)!;
  const powerAfter = after.get(1)!;
  const logicBefore = before.get(0.25)!;
  const logicAfter = after.get(0.25)!;

  expect(solver.solved).toBe(true);
  expect(solver.failed).toBe(false);
  expect(powerBefore.nominalCoverage).toBeLessThan(0.02);
  expect(powerAfter.nominalCoverage).toBeGreaterThan(0.45);
  expect(powerAfter.averageWidth).toBeGreaterThan(0.6);
  expect(logicAfter.nominalCoverage).toBeGreaterThan(0.85);
  expect(logicAfter.nominalCoverage).toBeGreaterThan(
    logicBefore.nominalCoverage * 2,
  );
  expect(solver.reroutedSegmentCount).toBeGreaterThan(50);
  expect(solver.keptTraceCount).toBeGreaterThanOrEqual(96);

  await expect(solver.visualize()).toMatchGraphicsSvg(import.meta.path);
});
