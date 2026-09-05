import type { PowerTraceExpanderInput, ViaRoutePoint } from "../../src/types";

export type ViaSpanApi = "endpoints" | "layers";

export const createViaSpanProblem = (
  api: ViaSpanApi,
): PowerTraceExpanderInput => {
  const layer = api === "endpoints" ? "bottom" : "inner1";
  const via: ViaRoutePoint & { layers?: string[] } = {
    route_type: "via",
    x: 0,
    y: 0,
    from_layer: "top",
    to_layer: "inner2",
    via_diameter: 0.3,
    via_hole_diameter: 0.1,
    ...(api === "layers" ? { layers: ["bottom"] } : {}),
  };
  return {
    layerCount: 4,
    minTraceWidth: 0.1,
    bounds: { minX: -3, maxX: 3, minY: -2, maxY: 2 },
    obstacles: [],
    connections: [
      {
        name: "POWER",
        nominalTraceWidth: 0.8,
        pointsToConnect: [
          { x: -2, y: 0.5, layer },
          { x: 2, y: 0.5, layer },
        ],
      },
    ],
    traces: [
      {
        type: "pcb_trace",
        pcb_trace_id: "power",
        connection_name: "POWER",
        route: [
          { route_type: "wire", x: -2, y: 0.5, width: 0.1, layer },
          { route_type: "wire", x: 2, y: 0.5, width: 0.1, layer },
        ],
      },
    ],
    fixedTraces: [
      {
        type: "pcb_trace",
        pcb_trace_id: "via",
        connection_name: "VIA",
        route: [via],
      },
    ],
  };
};
