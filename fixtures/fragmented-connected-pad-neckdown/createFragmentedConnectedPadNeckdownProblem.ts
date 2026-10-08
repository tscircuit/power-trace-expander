import type { SimpleRouteJson } from "@tscircuit/core";

export const FRAGMENTED_PAD_CONNECTION = "POWER";
export const FRAGMENTED_PAD_ID = "pcb_smtpad_fragmented";
export const FRAGMENTED_PAD_MINIMUM_TRACE_WIDTH = 0.15;
export const FRAGMENTED_PAD_NOMINAL_TRACE_WIDTH = 0.5;

const createWire = ({
  x,
  y,
  width,
}: {
  x: number;
  y: number;
  width: number;
}) => ({
  route_type: "wire" as const,
  x,
  y,
  width,
  layer: "top",
});

/**
 * A minimal valid SRJ where three adjacent rectangles represent one physical
 * pad. The shared pcb_smtpad alias makes the pad identity unambiguous without
 * depending on a Core conversion or a board-specific footprint.
 */
export const createFragmentedConnectedPadNeckdownProblem =
  (): SimpleRouteJson => ({
    layerCount: 2,
    minTraceWidth: FRAGMENTED_PAD_MINIMUM_TRACE_WIDTH,
    defaultObstacleMargin: 0.1,
    bounds: { minX: -1, minY: -1, maxX: 4, maxY: 1 },
    obstacles: [
      ...[-0.1, 0, 0.1].map((y, fragmentIndex) => ({
        obstacleId: `fragmented-pad-${fragmentIndex}`,
        type: "rect" as const,
        center: { x: 0, y },
        width: 0.6,
        height: 0.1,
        layers: ["top"],
        connectedTo: [FRAGMENTED_PAD_ID, FRAGMENTED_PAD_CONNECTION],
      })),
      {
        obstacleId: "destination-pad",
        type: "rect" as const,
        center: { x: 3, y: 0.01 },
        width: 0.6,
        height: 0.6,
        layers: ["top"],
        connectedTo: ["pcb_smtpad_destination", FRAGMENTED_PAD_CONNECTION],
      },
    ],
    connections: [
      {
        name: FRAGMENTED_PAD_CONNECTION,
        nominalTraceWidth: FRAGMENTED_PAD_NOMINAL_TRACE_WIDTH,
        pointsToConnect: [
          { x: 0, y: 0.01, layer: "top" },
          { x: 3, y: 0.01, layer: "top" },
        ],
      },
    ],
    traces: [
      {
        type: "pcb_trace",
        pcb_trace_id: "power-trace",
        connection_name: FRAGMENTED_PAD_CONNECTION,
        route: [
          createWire({
            x: 0,
            y: 0.01,
            width: FRAGMENTED_PAD_MINIMUM_TRACE_WIDTH,
          }),
          createWire({
            x: 3,
            y: 0.01,
            width: FRAGMENTED_PAD_MINIMUM_TRACE_WIDTH,
          }),
        ],
      },
    ],
  });
