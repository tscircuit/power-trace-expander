import {
  getSvgFromGraphicsObject,
  stackGraphicsHorizontally,
  type GraphicsObject,
} from "graphics-debug";
import { ConnectionNameResolver } from "../../src/ConnectionNameResolver";
import type {
  CollisionQuery,
  IndexedObstacle,
  SimpleRouteJson,
  SimplifiedPcbTrace,
} from "../../src/types";

export class CountingAliasResolver extends ConnectionNameResolver {
  readonly setLookups = new Map<string[], number>();
  readonly canonicalizations = new Map<string[], number>();

  override canonicalizeToSet(names: string[]): ReadonlySet<string> {
    this.setLookups.set(names, (this.setLookups.get(names) ?? 0) + 1);
    return super.canonicalizeToSet(names);
  }

  override canonicalize(names: string[]): string[] {
    this.canonicalizations.set(
      names,
      (this.canonicalizations.get(names) ?? 0) + 1,
    );
    return super.canonicalize(names);
  }
}

export function drawAliasIndex({
  input,
  traces = input.traces ?? [],
  items = [],
  queries = [],
  notes = [],
  obstacleColors = [],
}: {
  input: SimpleRouteJson;
  traces?: SimplifiedPcbTrace[];
  items?: IndexedObstacle[];
  queries?: Array<{ query: CollisionQuery; blocked: boolean }>;
  notes?: string[];
  obstacleColors?: string[];
}): GraphicsObject {
  const { bounds } = input;
  const fontSize = (bounds.maxX - bounds.minX) / 42;
  return {
    coordinateSystem: "cartesian",
    rects: [
      {
        center: {
          x: (bounds.minX + bounds.maxX) / 2,
          y: (bounds.minY + bounds.maxY) / 2,
        },
        width: bounds.maxX - bounds.minX,
        height: bounds.maxY - bounds.minY,
        fill: "transparent",
        stroke: "#cbd5e1",
      },
      ...input.obstacles.map((obstacle, index) => ({
        center: obstacle.center,
        width: obstacle.width,
        height: obstacle.height,
        ccwRotationDegrees: obstacle.ccwRotationDegrees,
        // The SVG renderer draws rectangles over lines. Keep pads translucent
        // so the prospective route remains visible through same-net copper.
        fill: obstacleColors[index] ?? "rgba(37,99,235,0.15)",
        stroke: "#64748b",
      })),
      ...items.map((item) => ({
        center: {
          x: (item.minX + item.maxX) / 2,
          y: (item.minY + item.maxY) / 2,
        },
        width: item.maxX - item.minX,
        height: item.maxY - item.minY,
        fill: "transparent",
        stroke: "#94a3b8",
      })),
    ],
    lines: [
      ...traces.flatMap((trace) =>
        trace.route.slice(1).flatMap((end, index) => {
          const start = trace.route[index]!;
          if (start.route_type !== "wire" || end.route_type !== "wire")
            return [];
          return [
            {
              points: [start, end],
              strokeWidth: start.width,
              strokeColor: "#2563eb",
            },
          ];
        }),
      ),
      ...queries.map(({ query, blocked }) => ({
        points: [query.start, query.end],
        strokeWidth: query.width,
        strokeColor: blocked ? "#dc2626" : "#15803d",
      })),
    ],
    circles: traces.flatMap((trace) =>
      trace.route.flatMap((point) =>
        point.route_type === "via"
          ? [
              {
                center: point,
                radius: (point.via_diameter ?? 0.6) / 2,
                fill: "#fbbf24",
                stroke: "#92400e",
              },
            ]
          : [],
      ),
    ),
    texts: notes.map((text, index) => ({
      x: bounds.minX,
      y: bounds.minY - (index + 1.5) * fontSize * 1.5,
      text,
      fontSize,
      anchorSide: "center_left",
      color: "#334155",
    })),
  };
}

export function aliasIndexSnapshot(
  panels: GraphicsObject[],
  titles: string[],
): string {
  return getSvgFromGraphicsObject(
    stackGraphicsHorizontally(panels, { titles }),
    {
      backgroundColor: "white",
      svgWidth: 1200,
      svgHeight: 520,
    },
  ).replace(/[ \t]+$/gm, "");
}
