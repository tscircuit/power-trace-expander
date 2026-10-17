import type { GraphicsObject } from "graphics-debug";
import { SpatialObstacleIndex } from "../../src";
import type {
  PowerTraceExpanderInput,
  SimplifiedPcbTrace,
} from "../../src/types";
import type { ViaSpanCase } from "./createViaSpanProblem";

/** Shows the actual obstacle index, not the via's intended physical span. */
export const getViaSpanGraphics = (
  input: PowerTraceExpanderInput,
  output: SimplifiedPcbTrace[],
  spanCase: ViaSpanCase,
): GraphicsObject => {
  const index = new SpatialObstacleIndex(input, []);
  const layers = index.boardLayers;
  const lines: NonNullable<GraphicsObject["lines"]> = [];
  const circles: NonNullable<GraphicsObject["circles"]> = [];
  const rects: NonNullable<GraphicsObject["rects"]> = [];
  const texts: NonNullable<GraphicsObject["texts"]> = [
    {
      x: 0,
      y: 2.5,
      text:
        spanCase === "endpoints"
          ? "Declared via span: top to inner2 (excludes bottom)"
          : "Declared via span: inner2 to top (excludes bottom)",
      fontSize: 0.17,
    },
    {
      x: 0,
      y: 2,
      text: "Blue: expanded power (0.8 mm) | Gray: input centerline",
      fontSize: 0.16,
    },
    {
      x: 0,
      y: 1.65,
      text: "Amber circles: via copper reported by the obstacle index",
      fontSize: 0.16,
    },
  ];
  for (const [layerIndex, layer] of layers.entries()) {
    const y = -layerIndex * 2.6;
    rects.push({
      center: { x: 0, y: y + 0.3 },
      width: 6,
      height: 2,
      fill: "none",
      stroke: "#cbd5e1",
    });
    texts.push({
      x: -2.7,
      y: y + 1,
      text: layer,
      anchorSide: "center_left",
      fontSize: 0.2,
    });
    for (const trace of input.traces!) {
      const route = trace.route;
      for (let i = 0; i < route.length - 1; i++) {
        const a = route[i]!;
        const b = route[i + 1]!;
        if (
          a.route_type !== "wire" ||
          b.route_type !== "wire" ||
          a.layer !== layer ||
          b.layer !== layer
        )
          continue;
        lines.push({
          points: [
            { x: a.x, y: a.y + y },
            { x: b.x, y: b.y + y },
          ],
          strokeWidth: 0.03,
          strokeColor: "#64748b",
          strokeDash: [0.1, 0.1],
          zIndex: 2,
        });
      }
    }
    for (const trace of output) {
      const route = trace.route;
      for (let i = 0; i < route.length - 1; i++) {
        const a = route[i]!;
        const b = route[i + 1]!;
        if (
          a.route_type !== "wire" ||
          b.route_type !== "wire" ||
          a.layer !== layer ||
          b.layer !== layer
        )
          continue;
        lines.push({
          points: [
            { x: a.x, y: a.y + y },
            { x: b.x, y: b.y + y },
          ],
          strokeWidth: Math.max(a.width, b.width),
          strokeColor: "#2563eb",
        });
      }
    }
    for (const item of index.items) {
      if (item.kind !== "via" || !item.layers.includes(layer)) continue;
      circles.push({
        center: {
          x: (item.minX + item.maxX) / 2,
          y: (item.minY + item.maxY) / 2 + y,
        },
        radius: (item.maxX - item.minX) / 2,
        fill: "#fbbf24",
        stroke: "#92400e",
      });
    }
  }
  return {
    title:
      spanCase === "endpoints"
        ? "Via: top to inner2 | Power: bottom"
        : "Via: inner2 to top | Power: bottom",
    coordinateSystem: "cartesian",
    lines,
    circles,
    rects,
    texts,
  };
};
