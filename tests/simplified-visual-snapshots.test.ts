import { expect, test } from "bun:test";
import "bun-match-svg";
import "graphics-debug/matcher";
import { simplifiedCases } from "../fixtures/simplified-cases";
import { measureTraceWidths, PowerTraceExpanderSolver } from "../src";

for (const [caseName, fixture] of Object.entries(simplifiedCases)) {
  test(`${caseName} improves the power trace and matches its visual snapshot`, async () => {
    const before = measureTraceWidths(fixture, fixture.traces ?? []).get(0.8)!;
    const solver = new PowerTraceExpanderSolver(structuredClone(fixture));

    solver.solve();

    const after = measureTraceWidths(fixture, solver.getOutput()).get(0.8)!;
    expect(solver.solved).toBe(true);
    expect(solver.failed).toBe(false);
    expect(after.normalizedWidthDeficit).toBeLessThan(
      before.normalizedWidthDeficit,
    );
    if (caseName === "intermediateWidthChannel") {
      expect(after.nominalCoverage).toBe(0);
      expect(after.averageWidth).toBeGreaterThan(0.55);
      expect(after.averageWidth).toBeLessThan(0.65);
    } else if (caseName === "narrowChannelRetreat") {
      expect(after.p05Width).toBeGreaterThan(0.65);
      expect(after.nominalCoverage).toBeGreaterThan(0.4);
    } else {
      expect(after.nominalCoverage).toBe(1);
    }
    await expect(solver.visualize()).toMatchGraphicsSvg(import.meta.path, {
      svgName: caseName,
    });
  });
}
