import { convertSrjToGraphicsObject } from "@tscircuit/capacity-autorouter";
import type { SimpleRouteJson, SimplifiedPcbTrace } from "@tscircuit/core";

export const getPowerTraceGraphics = ({
  problem,
  traces,
  title = "Power traces by PCB layer",
}: {
  problem: SimpleRouteJson;
  traces: SimplifiedPcbTrace[];
  title?: string;
}) => ({
  ...convertSrjToGraphicsObject(
    { ...problem, traces } as Parameters<typeof convertSrjToGraphicsObject>[0],
    { traceColorMode: "layer" },
  ),
  coordinateSystem: "cartesian" as const,
  title,
});
