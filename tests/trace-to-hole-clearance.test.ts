import { expect, test } from "bun:test";
import { SpatialObstacleIndex } from "../src/SpatialObstacleIndex";
import { approximateObstacleWithRects } from "../src/geometry";
import type { SimpleRouteJson } from "../src/types";

test("trace-to-hole clearance selects the hole margin without changing pad or via clearance", () => {
  for (const clearance of [undefined, 0, 0.05, 0.2, 0.5]) {
    for (const shape of ["circle", undefined] as const) {
      const height = shape === "circle" ? 2 : 1;
      const srj: SimpleRouteJson = {
        layerCount: 2,
        minTraceWidth: 0.2,
        minTraceToPadEdgeClearance: 0.35,
        minTraceToHoleEdgeClearance: clearance,
        bounds: { minX: -5, maxX: 5, minY: -5, maxY: 5 },
        connections: [],
        obstacles: [
          {
            type: "rect",
            isNonPlatedHole: true,
            shape,
            center: { x: 0, y: 0 },
            width: 2,
            height,
            layers: ["top", "bottom"],
            connectedTo: [],
          },
        ],
      };
      const before = JSON.stringify(srj);
      const index = new SpatialObstacleIndex(srj, []);
      expect(
        approximateObstacleWithRects(srj.obstacles[0]!).every(
          (item) => item.obstacleKind === "hole",
        ),
      ).toBe(true);
      for (const layer of ["top", "bottom"]) {
        const y = height / 2 + 0.1 + (clearance ?? 0.35) + 0.001;
        const query = {
          start: { x: -3, y },
          end: { x: 3, y },
          width: 0.2,
          layer,
          connectionNames: ["signal"],
          obstacleClearance: 0.8,
        };
        expect(index.collides(query)).toBe(false);
        query.start.y -= 0.002;
        query.end.y -= 0.002;
        expect(index.collides(query)).toBe(true);
      }
      // A trace-only rule must not replace the existing via copper spacing.
      const viaQuery = {
        point: { x: 0, y: height / 2 + 0.2 + 0.35 + 0.001 },
        padDiameter: 0.4,
        holeDiameter: 0.2,
        layers: ["top", "bottom"],
        connectionNames: ["signal"],
      };
      expect(index.collidesVia(viaQuery)).toBe(false);
      viaQuery.point.y -= 0.002;
      expect(index.collidesVia(viaQuery)).toBe(true);
      expect(JSON.stringify(srj)).toBe(before);
      srj.obstacles[0]!.isNonPlatedHole = false;
      srj.obstacles[0]!.connectedTo = ["pcb_smtpad_pad"];
      const padIndex = new SpatialObstacleIndex(srj, []);
      for (const delta of [-0.001, 0.001]) {
        const y = height / 2 + 0.1 + 0.35 + delta;
        expect(
          padIndex.collides({
            start: { x: -3, y },
            end: { x: 3, y },
            width: 0.2,
            layer: "top",
            connectionNames: ["signal"],
          }),
        ).toBe(delta < 0);
      }
    }
  }
});
