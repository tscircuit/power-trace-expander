import { expect, test } from "bun:test";
import "bun-match-svg";
import "graphics-debug/matcher";
import type { SimplifiedPcbTrace } from "@tscircuit/core";
import { simplifiedCases } from "../fixtures/simplified-cases";
import { PowerTraceExpanderSolver } from "../src";

const getUnderWidthLength = (
  trace: SimplifiedPcbTrace,
  nominalWidth: number,
) => {
  let length = 0;
  for (let index = 0; index < trace.route.length - 1; index++) {
    const start = trace.route[index];
    const end = trace.route[index + 1];
    if (
      start?.route_type !== "wire" ||
      end?.route_type !== "wire" ||
      start.layer !== end.layer
    ) {
      continue;
    }
    if (start.width >= nominalWidth && end.width >= nominalWidth) continue;
    length += Math.hypot(end.x - start.x, end.y - start.y);
  }
  return length;
};

for (const [caseName, fixture] of Object.entries(simplifiedCases)) {
  test(`${caseName} improves the power trace and matches its visual snapshot`, async () => {
    const before = getUnderWidthLength(fixture.traces![0]!, 0.8);
    const solver = new PowerTraceExpanderSolver(structuredClone(fixture));

    solver.solve();

    const after = getUnderWidthLength(solver.getOutput()[0]!, 0.8);
    expect(solver.solved).toBe(true);
    expect(solver.failed).toBe(false);
    expect(after).toBeLessThan(before);
    expect(after).toBe(0);
    await expect(solver.visualize()).toMatchGraphicsSvg(import.meta.path, {
      svgName: caseName,
    });
  });
}
