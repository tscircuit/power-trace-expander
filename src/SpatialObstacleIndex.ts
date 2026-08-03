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
import type {
  CollisionQuery,
  IndexedObstacle,
  Obstacle,
  SimpleRouteJson,
  SimplifiedPcbTrace,
  ViaCollisionQuery,
} from "./types";

type ConnectedPad = {
  obstacle: Obstacle;
  canonicalConnectionNames: ReadonlySet<string>;
};

const getBoardLayers = (layerCount: number) => [
  "top",
  ...Array.from(
    { length: Math.max(0, layerCount - 2) },
    (_, index) => `inner${index + 1}`,
  ),
  ...(layerCount > 1 ? ["bottom"] : []),
];

export class SpatialObstacleIndex {
  readonly items: IndexedObstacle[];
  readonly clearance: number;
  readonly boardEdgeClearance: number;
  readonly boardLayers: string[];
  readonly minViaHoleEdgeToViaHoleEdgeClearance: number;
  readonly defaultViaHoleDiameter: number;
  readonly bounds: SimpleRouteJson["bounds"];
  private readonly maxIndexedViaHoleDiameter: number;
  private readonly index: Flatbush | null;
  private readonly connectionNameSets: ReadonlySet<string>[];
  private readonly connectionNameResolver: ConnectionNameResolver;
  private readonly connectedPads: ConnectedPad[];
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
    this.boardLayers = getBoardLayers(simpleRouteJson.layerCount);
    this.dynamicTraceIndex = dynamicTraceIndex;
    this.clearance = Math.max(
      simpleRouteJson.defaultObstacleMargin ?? 0,
      simpleRouteJson.minTraceToPadEdgeClearance ?? 0,
      0.1,
    );
    this.boardEdgeClearance =
      simpleRouteJson.minBoardEdgeClearance ?? this.clearance;
    this.minViaHoleEdgeToViaHoleEdgeClearance = Math.max(
      simpleRouteJson.minViaHoleEdgeToViaHoleEdgeClearance ?? 0,
      0.1,
    );
    this.defaultViaHoleDiameter =
      simpleRouteJson.min_via_hole_diameter ??
      simpleRouteJson.minViaHoleDiameter ??
      0.3;
    this.items = [
      ...simpleRouteJson.obstacles.flatMap((obstacle) =>
        approximateObstacleWithRects(obstacle),
      ),
      ...this.createTraceItems(simpleRouteJson.fixedTraces ?? [], true),
      ...this.createTraceItems(traces),
      ...extraItems,
    ];
    this.maxIndexedViaHoleDiameter = this.items.reduce(
      (maximum, item) =>
        item.kind === "via"
          ? Math.max(
              maximum,
              item.viaHoleDiameter ?? this.defaultViaHoleDiameter,
            )
          : maximum,
      this.defaultViaHoleDiameter,
    );
    this.connectionNameResolver = connectionNameResolver;
    this.connectionNameSets = this.items.map(
      (item) =>
        new Set(connectionNameResolver.canonicalize(item.connectionNames)),
    );
    this.connectedPads = simpleRouteJson.obstacles.flatMap((obstacle) => {
      if (
        !obstacle.connectedTo.some(
          (name) =>
            name.startsWith("pcb_smtpad_") ||
            name.startsWith("pcb_plated_hole_"),
        )
      ) {
        return [];
      }
      return [
        {
          obstacle,
          canonicalConnectionNames: new Set(
            connectionNameResolver.canonicalize(obstacle.connectedTo),
          ),
        },
      ];
    });
    this.index = this.items.length > 0 ? new Flatbush(this.items.length) : null;
    for (const item of this.items) {
      this.index!.add(item.minX, item.minY, item.maxX, item.maxY);
    }
    this.index?.finish();
  }

  private createTraceItems(
    traces: SimplifiedPcbTrace[],
    fixed = false,
  ): IndexedObstacle[] {
    const items: IndexedObstacle[] = [];
    for (let traceIndex = 0; traceIndex < traces.length; traceIndex++) {
      const trace = traces[traceIndex]!;
      const indexedTraceIndex = fixed ? undefined : traceIndex;
      const isDynamicTrace = !fixed && traceIndex === this.dynamicTraceIndex;
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
            // Core emits a through via on every copper layer between the
            // requested endpoints. Treating it as board-wide is conservative
            // for the common two-layer case and correct for multilayer boards.
            layers: this.boardLayers,
            kind: "via",
            connectionNames,
            traceIndex: indexedTraceIndex,
            routeStartIndex: routeIndex,
            routeEndIndex: routeIndex,
            viaHoleDiameter:
              point.via_hole_diameter ?? this.defaultViaHoleDiameter,
            exactShape: {
              type: "circle",
              center: { x: point.x, y: point.y },
              radius: diameter / 2,
            },
          });
          continue;
        }

        // Dynamic wire copper is replaced in place and must not block its own
        // reroute. Its existing vias remain mechanically fixed, though, and
        // must participate in same-net drill spacing checks.
        if (isDynamicTrace) continue;

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
              traceIndex: indexedTraceIndex,
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

  getConnectedPadWidthLimit(query: CollisionQuery): number | null {
    if (
      Math.hypot(query.end.x - query.start.x, query.end.y - query.start.y) <=
      1e-5
    ) {
      return null;
    }
    const startLimit = this.getConnectedPadWidthLimitAtPoint(
      query,
      query.start,
    );
    const endLimit = this.getConnectedPadWidthLimitAtPoint(query, query.end);
    if (startLimit === null) return endLimit;
    if (endLimit === null) return startLimit;
    return Math.min(startLimit, endLimit);
  }

  getConnectedPadWidthLimitAtPoint(
    query: CollisionQuery,
    point: { x: number; y: number },
  ): number | null {
    const padsAtPoint = this.getConnectedPadsAtPoint(query, point);
    if (padsAtPoint.length === 0) return null;
    return Math.max(
      ...padsAtPoint.map(({ obstacle }) =>
        this.getPadWidthNormalToQuery(obstacle, query),
      ),
    );
  }

  getConnectedPadEndpointWidthLimitAtPoint(
    query: CollisionQuery,
    point: { x: number; y: number },
  ): number | null {
    const padsAtPoint = this.getConnectedPadsAtPoint(query, point);
    if (padsAtPoint.length === 0) return null;
    return Math.max(
      ...padsAtPoint.map(({ obstacle }) => {
        const localPoint = this.getObstacleLocalPoint(point, obstacle);
        return Math.max(
          0,
          2 *
            Math.min(
              obstacle.width / 2 - Math.abs(localPoint.x),
              obstacle.height / 2 - Math.abs(localPoint.y),
            ),
        );
      }),
    );
  }

  getConnectedPadBoundaryPoint(
    query: CollisionQuery,
    endpoint: "start" | "end",
  ): { x: number; y: number } | null {
    const inside = endpoint === "start" ? query.start : query.end;
    const outside = endpoint === "start" ? query.end : query.start;
    const padsAtPoint = this.getConnectedPadsAtPoint(query, inside);
    const pad = padsAtPoint.sort(
      (a, b) =>
        this.getPadWidthNormalToQuery(b.obstacle, query) -
        this.getPadWidthNormalToQuery(a.obstacle, query),
    )[0];
    if (!pad || this.pointIsInsideObstacle(outside, pad.obstacle)) return null;
    return this.getObstacleBoundaryPoint(inside, outside, pad.obstacle);
  }

  private getConnectedPadsAtPoint(
    query: CollisionQuery,
    point: { x: number; y: number },
  ): ConnectedPad[] {
    const canonicalConnectionNames = new Set(
      this.connectionNameResolver.canonicalize(query.connectionNames),
    );
    return this.connectedPads.filter(
      ({ obstacle, canonicalConnectionNames: padConnectionNames }) =>
        obstacle.layers.includes(query.layer) &&
        [...padConnectionNames].some((name) =>
          canonicalConnectionNames.has(name),
        ) &&
        this.pointIsInsideObstacle(point, obstacle),
    );
  }

  private pointIsInsideObstacle(
    point: { x: number; y: number },
    obstacle: Obstacle,
  ) {
    const { x: localX, y: localY } = this.getObstacleLocalPoint(
      point,
      obstacle,
    );
    return (
      Math.abs(localX) <= obstacle.width / 2 + 1e-9 &&
      Math.abs(localY) <= obstacle.height / 2 + 1e-9
    );
  }

  private getObstacleLocalPoint(
    point: { x: number; y: number },
    obstacle: Obstacle,
  ) {
    const radians = -((obstacle.ccwRotationDegrees ?? 0) * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const dx = point.x - obstacle.center.x;
    const dy = point.y - obstacle.center.y;
    return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
  }

  private getPadWidthNormalToQuery(
    obstacle: Obstacle,
    query: CollisionQuery,
  ): number {
    const dx = query.end.x - query.start.x;
    const dy = query.end.y - query.start.y;
    const length = Math.hypot(dx, dy);
    if (length <= 1e-9) return Math.min(obstacle.width, obstacle.height);

    const normalX = -dy / length;
    const normalY = dx / length;
    const radians = -((obstacle.ccwRotationDegrees ?? 0) * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const localNormalX = normalX * cos - normalY * sin;
    const localNormalY = normalX * sin + normalY * cos;
    return (
      Math.abs(localNormalX) * obstacle.width +
      Math.abs(localNormalY) * obstacle.height
    );
  }

  private getObstacleBoundaryPoint(
    inside: { x: number; y: number },
    outside: { x: number; y: number },
    obstacle: Obstacle,
  ): { x: number; y: number } | null {
    const radians = -((obstacle.ccwRotationDegrees ?? 0) * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const toLocal = (point: { x: number; y: number }) => {
      const dx = point.x - obstacle.center.x;
      const dy = point.y - obstacle.center.y;
      return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
    };
    const localInside = toLocal(inside);
    const localOutside = toLocal(outside);
    const delta = {
      x: localOutside.x - localInside.x,
      y: localOutside.y - localInside.y,
    };
    const candidates: number[] = [];
    if (Math.abs(delta.x) > 1e-12) {
      const boundaryX = delta.x > 0 ? obstacle.width / 2 : -obstacle.width / 2;
      candidates.push((boundaryX - localInside.x) / delta.x);
    }
    if (Math.abs(delta.y) > 1e-12) {
      const boundaryY =
        delta.y > 0 ? obstacle.height / 2 : -obstacle.height / 2;
      candidates.push((boundaryY - localInside.y) / delta.y);
    }
    const exitT = Math.min(
      ...candidates.filter((value) => value >= 0 && value <= 1),
    );
    if (!Number.isFinite(exitT)) return null;
    return {
      x: inside.x + (outside.x - inside.x) * exitT,
      y: inside.y + (outside.y - inside.y) * exitT,
    };
  }

  getConnectedLayersAtPoint(point: { x: number; y: number }, names: string[]) {
    const canonicalNames = new Set(
      this.connectionNameResolver.canonicalize(names),
    );
    const layers = new Set<string>();
    const candidates =
      this.index?.search(point.x, point.y, point.x, point.y) ?? [];
    for (const itemIndex of candidates) {
      const item = this.items[itemIndex]!;
      if (item.kind !== "obstacle") continue;
      if (
        ![...this.connectionNameSets[itemIndex]!].some((name) =>
          canonicalNames.has(name),
        )
      ) {
        continue;
      }
      const containsPoint =
        item.exactShape?.type === "polygon"
          ? distanceSegmentToPolygon(point, point, item.exactShape.points) <=
            1e-9
          : item.exactShape?.type === "circle"
            ? Math.hypot(
                item.exactShape.center.x - point.x,
                item.exactShape.center.y - point.y,
              ) <=
              item.exactShape.radius + 1e-9
            : point.x >= item.minX - 1e-9 &&
              point.x <= item.maxX + 1e-9 &&
              point.y >= item.minY - 1e-9 &&
              point.y <= item.maxY + 1e-9;
      if (containsPoint) {
        for (const layer of item.layers) layers.add(layer);
      }
    }
    return [...layers];
  }

  /**
   * Checks a prospective through via. Copper clearance follows ordinary
   * same-net semantics, while drill-to-drill clearance applies even to vias
   * on the same net because the fabrication constraint is mechanical.
   */
  collidesVia(query: ViaCollisionQuery): boolean {
    for (const layer of query.layers) {
      if (
        this.collides({
          start: query.point,
          end: query.point,
          layer,
          width: query.padDiameter,
          connectionNames: query.connectionNames,
          ignoreTraceIndex: query.ignoreTraceIndex,
          ignoreTraceIndices: query.ignoreTraceIndices,
          ignoreRouteRange: query.ignoreRouteRange,
          obstacleClearance: query.obstacleClearance,
          blockSameNetObstacles: query.blockSameNetObstacles,
          sameNetObstacleClearance: query.sameNetObstacleClearance,
        })
      ) {
        return true;
      }
    }

    const minimumNewViaSpacing =
      query.holeDiameter + this.minViaHoleEdgeToViaHoleEdgeClearance;
    for (const point of query.otherNewViaPoints ?? []) {
      if (
        Math.hypot(point.x - query.point.x, point.y - query.point.y) <
        minimumNewViaSpacing - 1e-9
      ) {
        return true;
      }
    }

    for (const via of query.fixedVias ?? []) {
      const minimumSpacing =
        query.holeDiameter / 2 +
        via.holeDiameter / 2 +
        this.minViaHoleEdgeToViaHoleEdgeClearance;
      if (
        Math.hypot(via.point.x - query.point.x, via.point.y - query.point.y) <
        minimumSpacing - 1e-9
      ) {
        return true;
      }
    }

    const indexedViaSearchRadius =
      query.holeDiameter / 2 +
      this.maxIndexedViaHoleDiameter / 2 +
      this.minViaHoleEdgeToViaHoleEdgeClearance;
    const indexedViaCandidates =
      this.index?.search(
        query.point.x - indexedViaSearchRadius,
        query.point.y - indexedViaSearchRadius,
        query.point.x + indexedViaSearchRadius,
        query.point.y + indexedViaSearchRadius,
      ) ?? [];
    const seenTraceRoutePairs = new Set<string>();
    for (const itemIndex of indexedViaCandidates) {
      const item = this.items[itemIndex]!;
      if (item.kind !== "via" || item.exactShape?.type !== "circle") continue;
      if (
        item.traceIndex === query.ignoreTraceIndex &&
        query.ignoreRouteRange &&
        (item.routeEndIndex ?? -1) >= query.ignoreRouteRange.start &&
        (item.routeStartIndex ?? Number.POSITIVE_INFINITY) <=
          query.ignoreRouteRange.end
      ) {
        continue;
      }
      if (query.ignoreTraceIndices?.includes(item.traceIndex ?? -1)) {
        continue;
      }
      const key = `${item.traceIndex ?? -1}:${item.routeStartIndex ?? -1}`;
      if (seenTraceRoutePairs.has(key)) continue;
      seenTraceRoutePairs.add(key);
      const existingHoleDiameter =
        item.viaHoleDiameter ?? this.defaultViaHoleDiameter;
      const minimumSpacing =
        query.holeDiameter / 2 +
        existingHoleDiameter / 2 +
        this.minViaHoleEdgeToViaHoleEdgeClearance;
      if (
        Math.hypot(
          item.exactShape.center.x - query.point.x,
          item.exactShape.center.y - query.point.y,
        ) <
        minimumSpacing - 1e-9
      ) {
        return true;
      }
    }
    return false;
  }

  private getCollisionCandidates(query: CollisionQuery) {
    const maximumClearance = Math.max(
      this.clearance,
      query.obstacleClearance ?? this.clearance,
      query.sameNetObstacleClearance ?? 0,
    );
    const radius = query.width / 2 + maximumClearance;
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
    const isSameNet = canonicalConnectionNames.some((name) =>
      itemConnectionNames.has(name),
    );
    if (
      isSameNet &&
      !(
        query.blockSameNetObstacles &&
        item.kind === "obstacle" &&
        item.obstacleKind !== "via"
      )
    ) {
      return false;
    }
    if (
      item.kind === "trace" &&
      query.ignoreTraceIndices?.includes(item.traceIndex ?? -1)
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
    const itemClearance =
      item.kind === "obstacle" && item.obstacleKind === "pad"
        ? isSameNet && query.blockSameNetObstacles
          ? (query.sameNetObstacleClearance ??
            query.obstacleClearance ??
            this.clearance)
          : (query.obstacleClearance ?? this.clearance)
        : this.clearance;
    const itemRadius = query.width / 2 + itemClearance;
    if (item.exactShape?.type === "segment") {
      return (
        distanceSegmentToSegment(
          query.start,
          query.end,
          item.exactShape.start,
          item.exactShape.end,
        ) <=
        itemRadius + item.exactShape.width / 2 + 1e-9
      );
    }
    if (item.exactShape?.type === "polygon") {
      return (
        distanceSegmentToPolygon(
          query.start,
          query.end,
          item.exactShape.points,
        ) <=
        itemRadius + 1e-9
      );
    }
    if (item.exactShape?.type === "circle") {
      return (
        distancePointToSegment(
          item.exactShape.center,
          query.start,
          query.end,
        ) <=
        itemRadius + item.exactShape.radius + 1e-9
      );
    }
    return segmentIntersectsRect(query.start, query.end, {
      minX: item.minX - itemRadius,
      minY: item.minY - itemRadius,
      maxX: item.maxX + itemRadius,
      maxY: item.maxY + itemRadius,
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
