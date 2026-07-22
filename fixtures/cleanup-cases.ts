import type { SimpleRouteJson, SimplifiedPcbTrace } from "@tscircuit/core";

const wire = (
  x: number,
  y: number,
  width: number,
  layer: "top" | "bottom" = "top",
) => ({ route_type: "wire" as const, x, y, width, layer });

const via = (x: number, y: number) => ({
  route_type: "via" as const,
  x,
  y,
  from_layer: "top" as const,
  to_layer: "bottom" as const,
  via_diameter: 0.6,
  via_hole_diameter: 0.3,
});

const powerTrace = (
  route: SimplifiedPcbTrace["route"],
): SimplifiedPcbTrace => ({
  type: "pcb_trace",
  pcb_trace_id: "power-trace",
  connection_name: "POWER",
  route,
});

const baseProblem = {
  layerCount: 2,
  minTraceWidth: 0.15,
  nominalTraceWidth: 0.8,
  defaultObstacleMargin: 0.15,
  minTraceToPadEdgeClearance: 0.15,
  minViaHoleDiameter: 0.3,
  minViaPadDiameter: 0.6,
  bounds: { minX: -6, maxX: 6, minY: -4, maxY: 4 },
  obstacles: [],
} satisfies Partial<SimpleRouteJson>;

export const cleanupCases = {
  viaPairElimination: {
    ...baseProblem,
    connections: [
      {
        name: "POWER",
        nominalTraceWidth: 0.8,
        pointsToConnect: [
          { x: -5, y: 0, layer: "top" },
          { x: 5, y: 0, layer: "top" },
        ],
      },
    ],
    traces: [
      powerTrace([
        wire(-5, 0, 0.8),
        wire(-1.5, 0, 0.8),
        via(-1.5, 0),
        wire(-1.5, 0, 0.8, "bottom"),
        wire(1.5, 0, 0.8, "bottom"),
        via(1.5, 0),
        wire(1.5, 0, 0.8),
        wire(5, 0, 0.8),
      ]),
    ],
  },

  viaPairObstacleDetour: {
    ...baseProblem,
    connections: [
      {
        name: "POWER",
        nominalTraceWidth: 0.8,
        pointsToConnect: [
          { x: -4, y: 0, layer: "top" },
          { x: 4, y: 0, layer: "top" },
        ],
      },
    ],
    obstacles: [
      {
        type: "rect",
        obstacleId: "top-layer-blocker",
        center: { x: 0, y: 0 },
        width: 2,
        height: 2,
        layers: ["top"],
        connectedTo: [],
      },
    ],
    traces: [
      powerTrace([
        wire(-4, 0, 0.8),
        wire(-2, 0, 0.8),
        via(-2, 0),
        wire(-2, 0, 0.8, "bottom"),
        wire(2, 0, 0.8, "bottom"),
        via(2, 0),
        wire(2, 0, 0.8),
        wire(4, 0, 0.8),
      ]),
    ],
  },

  clearanceShoveSimplification: {
    ...baseProblem,
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
          { x: -5, y: 0.65, layer: "top" },
          { x: 5, y: 0.65, layer: "top" },
        ],
      },
    ],
    traces: [
      powerTrace([
        wire(-4, 0, 0.8),
        wire(-1.25, -0.9, 0.8),
        wire(1.25, -0.9, 0.8),
        wire(4, 0, 0.8),
      ]),
      {
        type: "pcb_trace",
        pcb_trace_id: "signal-trace",
        connection_name: "SIGNAL",
        route: [wire(-5, 0.65, 0.15), wire(5, 0.65, 0.15)],
      },
    ],
  },

  routedViaInConnectedPad: {
    ...baseProblem,
    defaultObstacleMargin: 0.1,
    minTraceToPadEdgeClearance: 0.1,
    connections: [
      {
        name: "POWER",
        nominalTraceWidth: 0.8,
        pointsToConnect: [
          { x: -4, y: 0, layer: "top" },
          { x: 4, y: 0, layer: "bottom" },
        ],
      },
    ],
    obstacles: [
      {
        type: "rect",
        obstacleId: "pcb_smtpad_connected",
        center: { x: 0, y: 0 },
        width: 1,
        height: 1,
        layers: ["top"],
        connectedTo: ["pcb_smtpad_connected", "POWER"],
      },
    ],
    traces: [
      powerTrace([
        wire(-4, 0, 0.8),
        wire(0, 0, 0.8),
        via(0, 0),
        wire(0, 0, 0.8, "bottom"),
        wire(4, 0, 0.8, "bottom"),
      ]),
    ],
  },

  clusteredSameNetVias: {
    ...baseProblem,
    defaultObstacleMargin: 0.1,
    minTraceToPadEdgeClearance: 0.1,
    connections: [
      {
        name: "POWER",
        nominalTraceWidth: 0.8,
        pointsToConnect: [
          { x: -4, y: -0.4, layer: "top" },
          { x: 4, y: -0.4, layer: "bottom" },
        ],
      },
    ],
    traces: [
      powerTrace([
        wire(-4, -0.4, 0.8),
        wire(0, -0.4, 0.8),
        via(0, -0.4),
        wire(0, -0.4, 0.8, "bottom"),
        wire(4, -0.4, 0.8, "bottom"),
      ]),
      {
        ...powerTrace([
          wire(-4, 0.4, 0.8),
          wire(0.05, -0.4, 0.8),
          via(0.05, -0.4),
          wire(0.05, -0.4, 0.8, "bottom"),
          wire(4, 0.4, 0.8, "bottom"),
        ]),
        pcb_trace_id: "power-trace-2",
      },
    ],
  },

  powerTracePadClearance: {
    ...baseProblem,
    defaultObstacleMargin: 0.1,
    minTraceToPadEdgeClearance: 0.1,
    connections: [
      {
        name: "POWER",
        nominalTraceWidth: 0.8,
        pointsToConnect: [
          { x: -4, y: 0, layer: "top" },
          { x: 4, y: 0, layer: "top" },
        ],
      },
    ],
    obstacles: [
      {
        type: "rect",
        obstacleId: "pcb_smtpad_unrelated",
        center: { x: 0, y: 0.8 },
        width: 1.2,
        height: 0.6,
        layers: ["top"],
        connectedTo: ["pcb_smtpad_unrelated", "SIGNAL"],
      },
    ],
    traces: [powerTrace([wire(-4, 0, 0.8), wire(4, 0, 0.8)])],
  },

  constrainedPadClearance: {
    ...baseProblem,
    bounds: { minX: -6, maxX: 6, minY: -1.4, maxY: 1.6 },
    defaultObstacleMargin: 0.1,
    minTraceToPadEdgeClearance: 0.1,
    connections: [
      {
        name: "POWER",
        nominalTraceWidth: 0.8,
        pointsToConnect: [
          { x: -4, y: 0, layer: "top" },
          { x: 4, y: 0, layer: "top" },
        ],
      },
    ],
    obstacles: [
      {
        type: "rect",
        obstacleId: "pcb_smtpad_unrelated",
        center: { x: 0, y: 0.8 },
        width: 1.2,
        height: 0.6,
        layers: ["top"],
        connectedTo: ["pcb_smtpad_unrelated", "SIGNAL"],
      },
      {
        type: "rect",
        obstacleId: "lower-keepout",
        center: { x: 0, y: -1 },
        width: 4,
        height: 0.6,
        layers: ["top"],
        connectedTo: ["lower-keepout"],
      },
    ],
    traces: [powerTrace([wire(-4, 0, 0.8), wire(4, 0, 0.8)])],
  },
} satisfies Record<string, SimpleRouteJson>;
