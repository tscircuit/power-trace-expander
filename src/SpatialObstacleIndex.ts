import type { SimpleRouteJson, SimplifiedPcbTrace } from "@tscircuit/core";
import Flatbush from "flatbush";
import { ConnectionNameResolver } from "./ConnectionNameResolver";
import {
  approximateObstacleWithRects,
  approximateSegmentWithRects,
  distancePointToSegment,
  distanceSegmentToPolygon,
  distanceSegmentToSegment,
  segmentIntersectsRect,
} from "./geometry";
import type { CollisionQuery, IndexedObstacle } from "./types";

export class SpatialObstacleIndex {
  readonly items: IndexedObstacle[];
  readonly clearance: number;
  readonly boardEdgeClearance: number;
  readonly bounds: SimpleRouteJson["bounds"];
  private readonly index: Flatbush | null;
  private readonly connectionNameSets: ReadonlySet<string>[];
  private readonly connectionNameResolver: ConnectionNameResolver;
  private readonly dynamicTraceIndex?: number;

  constructor(
    simpleRouteJson: SimpleRouteJson,
    traces: SimplifiedPcbTrace[],
    dynamicTraceIndex?: number,
    extraItems: IndexedObstacle[] = [],
    connectionNameResolver = new ConnectionNameResolver(
      simpleRouteJson,
      traces,
    ),
  ) {
    this.bounds = simpleRouteJson.bounds;
    this.dynamicTraceIndex = dynamicTraceIndex;
    this.clearance = Math.max(
      simpleRouteJson.defaultObstacleMargin ?? 0,
      simpleRouteJson.minTraceToPadEdgeClearance ?? 0,
      0.1,
    );
    this.boardEdgeClearance =
      simpleRouteJson.minBoardEdgeClearance ?? this.clearance;
    this.items = [
      ...simpleRouteJson.obstacles.flatMap((obstacle) =>
        approximateObstacleWithRects(obstacle),
      ),
      ...this.createTraceItems(traces),
      ...extraItems,
    ];
    this.connectionNameSets = this.items.map(
      (item) =>
        new Set(connectionNameResolver.canonicalize(item.connectionNames)),
    );
    this.connectionNameResolver = connectionNameResolver;
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
        trace.source_trace_id,
        trace.rootConnectionName,
        ...(trace.mergedConnectionNames ?? []),
        ...(trace.connectsTo ?? []),
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
            exactShape: {
              type: "circle",
              center: { x: point.x, y: point.y },
              radius: diameter / 2,
            },
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
            // Circuit JSON and @tscircuit/checks assign each wire segment the
            // width of its first route point.
            width: point.width,
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
    if (this.isOutsideBounds(query)) return true;
    const { radius, candidates, canonicalConnectionNames } =
      this.getCollisionCandidates(query);
    for (const itemIndex of candidates) {
      if (this.itemCollides(itemIndex, query, radius, canonicalConnectionNames))
        return true;
    }
    return false;
  }

  findCollisions(query: CollisionQuery): IndexedObstacle[] {
    const { radius, candidates, canonicalConnectionNames } =
      this.getCollisionCandidates(query);
    const collisions: IndexedObstacle[] = [];
    for (const itemIndex of candidates) {
      if (
        this.itemCollides(itemIndex, query, radius, canonicalConnectionNames)
      ) {
        collisions.push(this.items[itemIndex]!);
      }
    }
    return collisions;
  }

  private getCollisionCandidates(query: CollisionQuery) {
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
    return {
      radius,
      candidates,
      canonicalConnectionNames: this.connectionNameResolver.canonicalize(
        query.connectionNames,
      ),
    };
  }

  private itemCollides(
    itemIndex: number,
    query: CollisionQuery,
    radius: number,
    canonicalConnectionNames: string[],
  ) {
    const item = this.items[itemIndex]!;
    if (!item.layers.includes(query.layer)) return false;
    // Connected copper is one obstacle-free routing region. This mirrors
    // @tscircuit/checks, which exempts same-net trace/trace, trace/pad, and
    // trace/via pairs from clearance errors. Different-net copper continues
    // to participate in both overlap and margin checks.
    const itemConnectionNames = this.connectionNameSets[itemIndex]!;
    if (
      canonicalConnectionNames.some((name) => itemConnectionNames.has(name))
    ) {
      return false;
    }
    if (
      item.kind === "trace" &&
      item.traceIndex === query.ignoreTraceIndex &&
      query.ignoreRouteRange &&
      (item.routeEndIndex ?? -1) >= query.ignoreRouteRange.start &&
      (item.routeStartIndex ?? Number.POSITIVE_INFINITY) <=
        query.ignoreRouteRange.end
    ) {
      return false;
    }
    if (item.exactShape?.type === "segment") {
      return (
        distanceSegmentToSegment(
          query.start,
          query.end,
          item.exactShape.start,
          item.exactShape.end,
        ) <=
        radius + item.exactShape.width / 2 + 1e-9
      );
    }
    if (item.exactShape?.type === "polygon") {
      return (
        distanceSegmentToPolygon(
          query.start,
          query.end,
          item.exactShape.points,
        ) <=
        radius + 1e-9
      );
    }
    if (item.exactShape?.type === "circle") {
      return (
        distancePointToSegment(
          item.exactShape.center,
          query.start,
          query.end,
        ) <=
        radius + item.exactShape.radius + 1e-9
      );
    }
    return segmentIntersectsRect(query.start, query.end, {
      minX: item.minX - radius,
      minY: item.minY - radius,
      maxX: item.maxX + radius,
      maxY: item.maxY + radius,
    });
  }

  private isOutsideBounds(query: CollisionQuery) {
    const radius = query.width / 2 + this.boardEdgeClearance;
    return (
      Math.min(query.start.x, query.end.x) - radius < this.bounds.minX ||
      Math.max(query.start.x, query.end.x) + radius > this.bounds.maxX ||
      Math.min(query.start.y, query.end.y) - radius < this.bounds.minY ||
      Math.max(query.start.y, query.end.y) + radius > this.bounds.maxY
    );
  }
}
