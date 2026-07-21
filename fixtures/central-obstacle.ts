import type { SimpleRouteJson } from "@tscircuit/core";

export const centralObstacleFixture: SimpleRouteJson = {
  layerCount: 2,
  minTraceWidth: 0.15,
  nominalTraceWidth: 0.8,
  defaultObstacleMargin: 0.15,
  minTraceToPadEdgeClearance: 0.15,
  minViaHoleDiameter: 0.3,
  minViaPadDiameter: 0.6,
  bounds: { minX: -5, maxX: 5, minY: -4, maxY: 4 },
  obstacles: [
    {
      type: "rect",
      obstacleId: "center-blocker",
      center: { x: 0, y: 0 },
      width: 2,
      height: 1.6,
      layers: ["top"],
      connectedTo: [],
    },
    {
      type: "rect",
      obstacleId: "diagonal-blocker",
      center: { x: 2.8, y: -2.4 },
      width: 1.8,
      height: 0.7,
      ccwRotationDegrees: 45,
      layers: ["top"],
      connectedTo: [],
    },
  ],
  connections: [
    {
      name: "MOTOR_VBUS",
      nominalTraceWidth: 0.8,
      pointsToConnect: [
        { x: -4, y: 0, layer: "top" },
        { x: 4, y: 0, layer: "top" },
      ],
    },
  ],
  traces: [
    {
      type: "pcb_trace",
      pcb_trace_id: "motor-vbus-trace",
      connection_name: "MOTOR_VBUS",
      route: [
        { route_type: "wire", x: -4, y: 0, width: 0.15, layer: "top" },
        { route_type: "wire", x: -1.2, y: 0, width: 0.15, layer: "top" },
        { route_type: "wire", x: 1.2, y: 0, width: 0.15, layer: "top" },
        { route_type: "wire", x: 4, y: 0, width: 0.15, layer: "top" },
      ],
    },
  ],
};
