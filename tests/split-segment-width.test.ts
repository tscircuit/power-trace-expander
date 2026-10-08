import { expect, test } from "bun:test";
import {
  distancePointToSegment,
  splitUnderWidthWireSegments,
} from "../src/geometry";
import type { WireRoutePoint } from "../src/types";

const wire = (x: number, width: number): WireRoutePoint => ({
  route_type: "wire",
  x,
  y: 0,
  width,
  layer: "top",
});

const hasCopperAt = (route: WireRoutePoint[], x: number, y: number) =>
  route.some((start, index) => {
    const end = route[index + 1];
    return (
      end !== undefined &&
      distancePointToSegment({ x, y }, start, end) <= start.width / 2
    );
  });

test("splitting preserves first-point copper width and only splits under-width segments", () => {
  // The endpoint's width belongs to its following segment. Interpolating toward
  // it can either add copper or erase an edge contact before expansion starts.
  const widths: [number, number][] = [
    [0.2, 0.8],
    [0.8, 0.2],
  ];
  for (const [startWidth, endWidth] of widths) {
    const original = [wire(0, startWidth), wire(3, endWidth)];
    const split = splitUnderWidthWireSegments(original, 1) as WireRoutePoint[];
    expect(split).toEqual([
      wire(0, startWidth),
      wire(1, startWidth),
      wire(2, startWidth),
      wire(3, endWidth),
    ]);
    const insideEdge = startWidth / 2 - 0.01;
    const outsideEdge = startWidth / 2 + 0.01;
    expect(hasCopperAt(original, 2.5, insideEdge)).toBe(true);
    expect(hasCopperAt(split, 2.5, insideEdge)).toBe(true);
    expect(hasCopperAt(original, 2.5, outsideEdge)).toBe(false);
    expect(hasCopperAt(split, 2.5, outsideEdge)).toBe(false);
    expect(original).toEqual([wire(0, startWidth), wire(3, endWidth)]);
  }

  const mixed = [wire(0, 1), wire(3, 0.2), wire(6, 0.2), wire(9, 1)];
  expect(splitUnderWidthWireSegments(mixed, 1)).toEqual([
    wire(0, 1),
    wire(3, 0.2),
    wire(4, 0.2),
    wire(5, 0.2),
    wire(6, 0.2),
    wire(7, 0.2),
    wire(8, 0.2),
    wire(9, 1),
  ]);
});
