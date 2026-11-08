import { expect, test } from "bun:test";
import "bun-match-svg";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { getSvgFromGraphicsObject, type GraphicsObject } from "graphics-debug";
import { PhysicalConnectivityInvariant } from "../src/PhysicalConnectivityInvariant";
import { removeUnusedTraceBacktracks } from "../src/removeUnusedTraceBacktracks";
import type { PowerTraceExpanderInput, SimplifiedPcbTrace } from "../src/types";

test("RVboy power expansion removes its unused copper backtrack without changing connectivity", async (): Promise<void> => {
  // Complete captured power-stage input and output. Only the SVG view is cropped.
  const { input, traces } = JSON.parse(
    gunzipSync(
      new Uint8Array(
        readFileSync(
          new URL("./fixtures/rvboy-power-backtrack.json.gz", import.meta.url),
        ),
      ),
    ).toString(),
  ) as { input: PowerTraceExpanderInput; traces: SimplifiedPcbTrace[] };
  const original = JSON.stringify(traces);
  const invariant = new PhysicalConnectivityInvariant(input, traces);
  const result = removeUnusedTraceBacktracks(input, traces, new Set());
  expect(result.removedCount).toBeGreaterThan(0);
  expect(JSON.stringify(traces)).toBe(original);
  expect(invariant.validate(result.traces).safe).toBeTrue();
  expect(
    removeUnusedTraceBacktracks(input, result.traces, new Set()).removedCount,
  ).toBe(0);
  const target = result.traces.find(
    (trace) => trace.pcb_trace_id === "source_net_8_mst2_0",
  )!;
  expect(
    target.route.some(
      (point) =>
        point.route_type === "wire" &&
        Math.hypot(point.x + 6.075, point.y - 18.025) < 1e-6,
    ),
  ).toBeFalse();
  for (const [state, candidates] of [
    ["before", traces],
    ["after", result.traces],
  ] as const) {
    const graphics: GraphicsObject = { lines: [], circles: [], rects: [] };
    for (const trace of [...(input.fixedTraces ?? []), ...candidates]) {
      const color =
        trace.pcb_trace_id === target.pcb_trace_id ? "red" : "#aaaaaa";
      for (let i = 1; i < trace.route.length; i++) {
        const a = trace.route[i - 1]!,
          b = trace.route[i]!;
        if (
          a.route_type !== "wire" ||
          b.route_type !== "wire" ||
          a.layer !== "top" ||
          b.layer !== "top"
        )
          continue;
        graphics.lines!.push({
          points: [a, b],
          strokeColor: color,
          strokeWidth: a.width,
        });
        graphics.circles!.push(
          ...[a, b].map((center) => ({
            center,
            radius: a.width / 2,
            fill: color,
            stroke: "none",
          })),
        );
      }
    }
    graphics.rects!.push({
      center: { x: -7.4, y: 17.9 },
      width: 3.4,
      height: 1.8,
      fill: "none",
      stroke: "none",
      label: "viewport",
    });
    const raw = getSvgFromGraphicsObject(graphics, {
      backgroundColor: "white",
      svgWidth: 1000,
      svgHeight: 600,
      includeTextLabels: false,
    });
    const tag = raw.match(/<rect\b[^>]*data-label="viewport"[^>]*\/>/)![0];
    const box = ["x", "y", "width", "height"].map((key) =>
      Number(tag.match(new RegExp(`\\s${key}="([^"]+)"`))![1]),
    );
    const cropped = raw.replace(
      /<svg\b[^>]*>/,
      `<svg x="0" y="70" width="1000" height="600" viewBox="${box.join(" ")}" overflow="hidden" xmlns="http://www.w3.org/2000/svg">`,
    );
    const svg = `<svg width="1000" height="670" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="white"/><text x="20" y="30" font-family="sans-serif" font-size="22">RVboy ${state}: remove the unused 0.615 mm copper stub</text><text x="20" y="56" font-family="sans-serif" font-size="16">Full native power-stage capture; physical connectivity and trace widths preserved</text>${cropped}</svg>`;
    await expect(svg).toMatchSvgSnapshot(import.meta.path, state);
  }
});
