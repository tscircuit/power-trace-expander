import { expect, test } from "bun:test";
import "bun-match-svg";
import "graphics-debug/matcher";
import { simplifiedCases } from "../fixtures/simplified-cases";
import { measureTraceWidths, PowerTraceExpanderSolver } from "../src";

for (const [caseName, fixture] of Object.entries(simplifiedCases)) {
  test(`${caseName} improves the power trace and matches its visual snapshot`, async () => {
    const nominalWidth =
      fixture.connections[0]?.nominalTraceWidth ??
      fixture.nominalTraceWidth ??
      fixture.minTraceWidth;
    const before = measureTraceWidths(fixture, fixture.traces ?? []).get(
      nominalWidth,
    )!;
    const solver = new PowerTraceExpanderSolver(structuredClone(fixture));

    solver.solve();

    const after = measureTraceWidths(fixture, solver.getOutput()).get(
      nominalWidth,
    )!;
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
    } else if (caseName === "layerChangeWithNecking") {
      const route = solver.getOutput()[0]!.route;
      expect(route.filter((point) => point.route_type === "via")).toHaveLength(
        2,
      );
      expect(
        route.some(
          (point) =>
            point.route_type === "wire" &&
            point.layer === "bottom" &&
            point.width === 1,
        ),
      ).toBe(true);
      expect(after.nominalCoverage).toBeGreaterThan(0.75);
      expect(after.averageWidth).toBeGreaterThan(0.97);
      expect(after.minimumWidth).toBeGreaterThanOrEqual(0.875);
    } else {
      expect(after.nominalCoverage).toBe(1);
    }
    await expect(solver.visualize()).toMatchGraphicsSvg(import.meta.path, {
      svgName: caseName,
    });
  });
}
