import { expect, test } from "bun:test";
import {
  distanceSegmentToSegment,
  distanceSegmentToPolygon,
  segmentsWithinDistance,
  segmentWithinPolygonDistance,
} from "../src/geometry";

test("boolean clearance predicates match exact distances at PCB clearance boundaries", () => {
  let state = 87231;
  const random = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  for (let i = 0; i < 10000; i++) {
    const point = () => ({
      x: (random() - 0.5) * 200,
      y: (random() - 0.5) * 200,
    });
    const a = point(),
      b = i % 11 ? point() : a,
      c = point(),
      d = i % 7 ? point() : c;
    if (i % 3 === 0) b.x = a.x;
    if (i % 5 === 0) d.y = c.y;
    const exact = distanceSegmentToSegment(a, b, c, d);
    for (const threshold of [
      0,
      0.15,
      0.3,
      exact,
      exact - 1e-10,
      exact + 1e-10,
    ]) {
      expect(segmentsWithinDistance(a, b, c, d, threshold)).toBe(
        exact <= threshold,
      );
    }
    const polygon = [
      c,
      { x: c.x + 0.7, y: c.y },
      { x: c.x + 0.6, y: c.y + 0.9 },
      { x: c.x, y: c.y + 0.4 },
    ];
    const polygonExact = distanceSegmentToPolygon(a, b, polygon);
    for (const threshold of [
      0.15,
      polygonExact,
      polygonExact - 1e-10,
      polygonExact + 1e-10,
    ]) {
      expect(segmentWithinPolygonDistance(a, b, polygon, threshold)).toBe(
        polygonExact <= threshold,
      );
    }
  }
});
