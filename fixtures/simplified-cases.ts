import type { SimpleRouteJson, SimplifiedPcbTrace } from "@tscircuit/core";

const wire = (x: number, y: number, width = 0.15) => ({
  route_type: "wire" as const,
  x,
  y,
  width,
  layer: "top" as const,
});

const powerTrace = (
  route: SimplifiedPcbTrace["route"],
): SimplifiedPcbTrace => ({
  type: "pcb_trace",
  pcb_trace_id: "power-trace",
  connection_name: "POWER",
  route,
});

const createBaseFixture = (overrides: Partial<SimpleRouteJson>) =>
  ({
    layerCount: 2,
    minTraceWidth: 0.15,
    nominalTraceWidth: 0.8,
    defaultObstacleMargin: 0.15,
    minTraceToPadEdgeClearance: 0.15,
    minViaHoleDiameter: 0.3,
    minViaPadDiameter: 0.6,
    bounds: { minX: -6, maxX: 6, minY: -5, maxY: 5 },
    obstacles: [],
    connections: [
      {
        name: "POWER",
        nominalTraceWidth: 0.8,
        pointsToConnect: [
          { x: -5, y: 0, layer: "top" as const },
          { x: 5, y: 0, layer: "top" as const },
        ],
      },
    ],
    traces: [powerTrace([wire(-5, 0), wire(5, 0)])],
    ...overrides,
  }) satisfies SimpleRouteJson;

export const simplifiedCases = {
  straightClear: createBaseFixture({
    traces: [powerTrace([wire(-5, -2), wire(0, 1), wire(5, -2)])],
    connections: [
      {
        name: "POWER",
        nominalTraceWidth: 0.8,
        pointsToConnect: [
          { x: -5, y: -2, layer: "top" },
          { x: 5, y: -2, layer: "top" },
        ],
      },
    ],
  }),

  centralObstacle: createBaseFixture({
    obstacles: [
      {
        type: "rect",
        obstacleId: "central-obstacle",
        center: { x: 0, y: 0 },
        width: 2,
        height: 1.8,
        layers: ["top"],
        connectedTo: [],
      },
    ],
    traces: [
      powerTrace([wire(-5, 0), wire(-1.2, 0), wire(1.2, 0), wire(5, 0)]),
    ],
  }),

  narrowChannelRetreat: createBaseFixture({
    obstacles: [
      {
        type: "rect",
        obstacleId: "upper-channel-wall",
        center: { x: 0, y: 2 },
        width: 3,
        height: 3,
        layers: ["top"],
        connectedTo: [],
      },
      {
        type: "rect",
        obstacleId: "lower-channel-wall",
        center: { x: 0, y: -2 },
        width: 3,
        height: 3,
        layers: ["top"],
        connectedTo: [],
      },
    ],
  }),

  longDetour: createBaseFixture({
    obstacles: [
      {
        type: "rect",
        obstacleId: "long-detour-wall",
        center: { x: 0, y: 0 },
        width: 2,
        height: 4.8,
        layers: ["top"],
        connectedTo: [],
      },
    ],
  }),

  rotatedObstacle: createBaseFixture({
    obstacles: [
      {
        type: "rect",
        obstacleId: "rotated-obstacle",
        center: { x: 0, y: 1.2 },
        width: 3,
        height: 0.4,
        ccwRotationDegrees: 25,
        layers: ["top"],
        connectedTo: [],
      },
    ],
  }),

  neighboringTrace: createBaseFixture({
    connections: [
      {
        name: "POWER",
        nominalTraceWidth: 0.8,
        pointsToConnect: [
          { x: -5, y: 0, layer: "top" },
          { x: 5, y: 0, layer: "top" },
        ],
      },
      {
        name: "SIGNAL",
        nominalTraceWidth: 0.15,
        pointsToConnect: [
          { x: -2, y: 0.6, layer: "top" },
          { x: 2, y: 0.6, layer: "top" },
        ],
      },
    ],
    traces: [
      powerTrace([wire(-5, 0), wire(5, 0)]),
      {
        type: "pcb_trace",
        pcb_trace_id: "neighboring-signal",
        connection_name: "SIGNAL",
        route: [wire(-2, 0.6), wire(2, 0.6)],
      },
    ],
  }),

  inflationPushesSignal: createBaseFixture({
    connections: [
      {
        name: "POWER",
        nominalTraceWidth: 0.8,
        pointsToConnect: [
          { x: -4, y: 0, layer: "top" },
          { x: 4, y: 0, layer: "top" },
        ],
      },
      {
        name: "SIGNAL",
        nominalTraceWidth: 0.15,
        pointsToConnect: [
          { x: -5, y: 0.55, layer: "top" },
          { x: 5, y: 0.55, layer: "top" },
        ],
      },
    ],
    traces: [
      powerTrace([wire(-4, 0), wire(4, 0)]),
      {
        type: "pcb_trace",
        pcb_trace_id: "pushable-signal",
        connection_name: "SIGNAL",
        route: [wire(-5, 0.55), wire(5, 0.55)],
      },
    ],
  }),
} satisfies Record<string, SimpleRouteJson>;
