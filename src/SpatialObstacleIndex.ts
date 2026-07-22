import type { SimpleRouteJson, SimplifiedPcbTrace } from "@tscircuit/core";
import Flatbush from "flatbush";
import {
  approximateObstacleWithRects,
  approximateSegmentWithRects,
  segmentIntersectsRect,
} from "./geometry";
import type { CollisionQuery, IndexedObstacle } from "./types";

const namesOverlap = (a: string[], b: string[]) =>
  a.some((name) => b.includes(name));

export class SpatialObstacleIndex {
  readonly items: IndexedObstacle[];
  readonly clearance: number;
  readonly bounds: SimpleRouteJson["bounds"];
  private readonly index: Flatbush | null;
  private readonly dynamicTraceIndex?: number;

  constructor(
    simpleRouteJson: SimpleRouteJson,
    traces: SimplifiedPcbTrace[],
    dynamicTraceIndex?: number,
    extraItems: IndexedObstacle[] = [],
  ) {
    this.bounds = simpleRouteJson.bounds;
    this.dynamicTraceIndex = dynamicTraceIndex;
    this.clearance = Math.max(
      simpleRouteJson.defaultObstacleMargin ?? 0.15,
      simpleRouteJson.minTraceToPadEdgeClearance ?? 0.15,
    );
    this.items = [
      ...simpleRouteJson.obstacles.flatMap((obstacle) =>
        approximateObstacleWithRects(obstacle),
      ),
      ...this.createTraceItems(traces),
      ...extraItems,
    ];
    this.index = this.items.length > 0 ? new Flatbush(this.items.length) : null;
    for (const item of this.items) {
      this.index!.add(item.minX, item.minY, item.maxX, item.maxY);
    }
    this.index?.finish();
  }

  private createTraceItems(traces: SimplifiedPcbTrace[]) {
    const items: IndexedObstacle[] = [];
    for (let traceIndex = 0; traceIndex < traces.length; traceIndex++) {
      if (traceIndex === this.dynamicTraceIndex) continue;
      const trace = traces[traceIndex]!;
      const connectionNames = [
        trace.connection_name,
        trace.rootConnectionName,
        ...(trace.mergedConnectionNames ?? []),
      ].filter((name): name is string => Boolean(name));

      for (let routeIndex = 0; routeIndex < trace.route.length; routeIndex++) {
        const point = trace.route[routeIndex]!;
        if (point.route_type === "via") {
          const diameter = point.via_diameter ?? 0.6;
          items.push({
            minX: point.x - diameter / 2,
            minY: point.y - diameter / 2,
            maxX: point.x + diameter / 2,
            maxY: point.y + diameter / 2,
            layers: [point.from_layer, point.to_layer],
            kind: "via",
            connectionNames,
            traceIndex,
            routeStartIndex: routeIndex,
            routeEndIndex: routeIndex,
          });
          continue;
        }

        const next = trace.route[routeIndex + 1];
        if (
          point.route_type !== "wire" ||
          next?.route_type !== "wire" ||
          point.layer !== next.layer
        ) {
          continue;
        }
        items.push(
          ...approximateSegmentWithRects({
            start: point,
            end: next,
            width: Math.max(point.width, next.width),
            base: {
              layers: [point.layer],
              kind: "trace",
              connectionNames,
              traceIndex,
              routeStartIndex: routeIndex,
              routeEndIndex: routeIndex + 1,
            },
          }),
        );
      }
    }
    return items;
  }

  collides(query: CollisionQuery): boolean {
    return this.isOutsideBounds(query) || this.findCollisions(query).length > 0;
  }

  findCollisions(query: CollisionQuery): IndexedObstacle[] {
    const radius = query.width / 2 + this.clearance;
    const queryBounds = {
      minX: Math.min(query.start.x, query.end.x) - radius,
      minY: Math.min(query.start.y, query.end.y) - radius,
      maxX: Math.max(query.start.x, query.end.x) + radius,
      maxY: Math.max(query.start.y, query.end.y) + radius,
    };
    const candidates =
      this.index?.search(
        queryBounds.minX,
        queryBounds.minY,
        queryBounds.maxX,
        queryBounds.maxY,
      ) ?? [];
    const collisions: IndexedObstacle[] = [];
    for (const itemIndex of candidates) {
      const item = this.items[itemIndex]!;
      if (!item.layers.includes(query.layer)) continue;
      // A route may enter a pad that belongs to its own connection. Separate
      // trace/via objects still participate in clearance checks even when they
      // are electrically connected; this matches tscircuit's geometry DRC.
      if (
        item.kind === "obstacle" &&
        namesOverlap(item.connectionNames, query.connectionNames)
      ) {
        continue;
      }
      if (
        item.kind === "trace" &&
        item.traceIndex === query.ignoreTraceIndex &&
        query.ignoreRouteRange &&
        (item.routeEndIndex ?? -1) >= query.ignoreRouteRange.start &&
        (item.routeStartIndex ?? Number.POSITIVE_INFINITY) <=
          query.ignoreRouteRange.end
      ) {
        continue;
      }
      if (
        segmentIntersectsRect(query.start, query.end, {
          minX: item.minX - radius,
          minY: item.minY - radius,
          maxX: item.maxX + radius,
          maxY: item.maxY + radius,
        })
      ) {
        collisions.push(item);
      }
    }
    return collisions;
  }

  private isOutsideBounds(query: CollisionQuery) {
    const radius = query.width / 2 + this.clearance;
    return (
      Math.min(query.start.x, query.end.x) - radius < this.bounds.minX ||
      Math.max(query.start.x, query.end.x) + radius > this.bounds.maxX ||
      Math.min(query.start.y, query.end.y) - radius < this.bounds.minY ||
      Math.max(query.start.y, query.end.y) + radius > this.bounds.maxY
    );
  }
}
