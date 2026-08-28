import { expect, test } from "bun:test";
import { centralObstacleFixture } from "../fixtures/central-obstacle";
import {
  ConnectionNameResolver,
  SpatialObstacleIndex,
  SpatialObstacleIndexStaticCache,
} from "../src";
import type { CollisionQuery } from "../src/types";

test("reuses immutable obstacle metadata without changing collision results", () => {
  const input = structuredClone(centralObstacleFixture);
  input.obstacles.push({
    type: "rect",
    obstacleId: "same-net-pad",
    center: { x: -3, y: 1 },
    width: 1,
    height: 1,
    layers: ["top"],
    connectedTo: ["MOTOR_VBUS", "pcb_smtpad_same_net"],
  });
  const traces = structuredClone(input.traces ?? []);
  const resolver = new ConnectionNameResolver(input, traces);
  const staticCache = new SpatialObstacleIndexStaticCache(input, resolver);
  const cachedIndex = new SpatialObstacleIndex(
    input,
    traces,
    undefined,
    [],
    resolver,
    staticCache,
  );

  const movedTraces = structuredClone(traces);
  const movedPoint = movedTraces[0]?.route[1];
  if (movedPoint?.route_type === "wire") movedPoint.y = -1;
  const reusedIndex = new SpatialObstacleIndex(
    input,
    movedTraces,
    undefined,
    [],
    resolver,
    staticCache,
  );
  const freshIndex = new SpatialObstacleIndex(
    input,
    movedTraces,
    undefined,
    [],
    resolver,
  );
  const queries = [
    {
      start: { x: -1, y: 0 },
      end: { x: 1, y: 0 },
      layer: "top",
      width: 0.2,
      connectionNames: ["OTHER_NET"],
    },
    {
      start: { x: -3.2, y: 1 },
      end: { x: -2.8, y: 1 },
      layer: "top",
      width: 0.2,
      connectionNames: ["MOTOR_VBUS"],
    },
    {
      start: { x: -3.2, y: 1 },
      end: { x: -2.8, y: 1 },
      layer: "top",
      width: 0.2,
      connectionNames: ["OTHER_NET"],
    },
  ] satisfies CollisionQuery[];
  const collisionSignatures = (index: SpatialObstacleIndex) =>
    queries.map((query) =>
      index.findCollisions(query).map((item) => ({
        kind: item.kind,
        copperObjectId: item.copperObjectId,
        minX: item.minX,
        minY: item.minY,
        maxX: item.maxX,
        maxY: item.maxY,
      })),
    );

  expect(collisionSignatures(reusedIndex)).toEqual(
    collisionSignatures(freshIndex),
  );
  expect(reusedIndex.items[0]).toBe(cachedIndex.items[0]);
  expect(reusedIndex.items[staticCache.obstacleItems.length]).not.toBe(
    cachedIndex.items[staticCache.obstacleItems.length],
  );
});
