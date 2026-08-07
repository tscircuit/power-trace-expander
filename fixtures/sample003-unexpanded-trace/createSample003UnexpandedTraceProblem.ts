import type { SimpleRouteJson } from "@tscircuit/core";

export const SAMPLE003_TARGET_TRACE_ID = "source_net_2_mst14_0";
export const SAMPLE003_TARGET_CONNECTION = "source_net_2";
export const SAMPLE003_NOMINAL_WIDTH = 1;

export const SAMPLE003_AVAILABLE_TOP_ROUTE = [
  { x: -31.689973, y: -18.99003695 },
  { x: -34, y: -18.99003695 },
  { x: -34, y: -0.5 },
  { x: -36.5375, y: 2 },
];

const PAD_COLUMN_Y = [
  -24.07003695, -21.53003695, -18.99003695, -16.45003695, -13.91003695,
  -11.37003695, -8.83003695, -6.29003695, -3.75003695, -1.21003695, 1.32996305,
  3.86996305, 6.40996305,
];

/**
 * Reduced from the input to the SRJ27 sample003 panel in
 * tscircuit-autorouter's pipeline7 power-expansion visual snapshot.
 */
export const createSample003UnexpandedTraceProblem = (): SimpleRouteJson => ({
  layerCount: 2,
  minTraceWidth: 0.15,
  minViaDiameter: 0.3,
  minViaHoleDiameter: 0.2,
  minViaPadDiameter: 0.3,
  min_via_hole_diameter: 0.2,
  min_via_pad_diameter: 0.3,
  minTraceToPadEdgeClearance: 0.1,
  minBoardEdgeClearance: 0.2,
  minViaHoleEdgeToViaHoleEdgeClearance: 0.1,
  bounds: {
    minX: -42,
    maxX: -28,
    minY: -29,
    maxY: 29,
  },
  connections: [
    {
      name: SAMPLE003_TARGET_CONNECTION,
      nominalTraceWidth: SAMPLE003_NOMINAL_WIDTH,
      width: 0.15,
      pointsToConnect: [
        {
          x: -36.5375,
          y: 2,
          layer: "top",
          pointId: "pcb_port_51",
          pcb_port_id: "pcb_port_51",
        },
        {
          x: -31.689973,
          y: -18.99003695,
          layer: "top",
          pointId: "pcb_port_37",
          pcb_port_id: "pcb_port_37",
        },
      ],
    },
  ],
  obstacles: [
    ...PAD_COLUMN_Y.map((y) => ({
      type: "rect" as const,
      layers: ["top"],
      center: { x: -31.689973, y },
      width: 3.1999936,
      height: 1.5999968,
      connectedTo:
        y === -18.99003695
          ? [SAMPLE003_TARGET_CONNECTION, "pcb_port_37", "pcb_port_51"]
          : [],
    })),
    {
      type: "rect",
      layers: ["top"],
      center: { x: -36.5375, y: 2 },
      width: 1.125,
      height: 1.75,
      connectedTo: [SAMPLE003_TARGET_CONNECTION, "pcb_port_37", "pcb_port_51"],
    },
  ],
  traces: [
    {
      type: "pcb_trace",
      pcb_trace_id: SAMPLE003_TARGET_TRACE_ID,
      connection_name: SAMPLE003_TARGET_CONNECTION,
      connectsTo: ["pcb_port_51", "pcb_port_37"],
      route: [
        {
          route_type: "wire",
          x: -31.689973,
          y: -18.99003695,
          width: 0.15,
          layer: "top",
        },
        {
          route_type: "wire",
          x: -31.851627816,
          y: -18.99003695,
          width: 0.15,
          layer: "top",
        },
        {
          route_type: "wire",
          x: -33.505017936,
          y: -17.33664683,
          width: 0.15,
          layer: "top",
        },
        {
          route_type: "wire",
          x: -33.505017936,
          y: -1.031982064,
          width: 0.15,
          layer: "top",
        },
        {
          route_type: "wire",
          x: -36.5375,
          y: 2,
          width: 0.15,
          layer: "top",
        },
      ],
    },
  ],
  fixedTraces: [],
});
