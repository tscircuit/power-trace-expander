import type { SimpleRouteJson, SimplifiedPcbTrace } from "@tscircuit/core";
import { PowerTraceExpanderSolver } from "../../src";
import { getPowerTraceGraphics } from "../getPowerTraceGraphics";
import sample001Input from "./input.json";

export const SAMPLE001_TARGET_TRACE_ID = "source_net_3_mst10_0";

export const SAMPLE001_UNNECESSARY_VIA_PAIR = [
  { x: -8.1, y: -12, from_layer: "top", to_layer: "bottom" },
  { x: -6, y: -10.5, from_layer: "bottom", to_layer: "top" },
];

const FOCUS_BOUNDS = {
  minX: -11,
  maxX: -4,
  minY: -15,
  maxY: -7,
};

const getFocusedTrace = (trace: SimplifiedPcbTrace): SimplifiedPcbTrace => {
  const startIndex = trace.route.findIndex(
    (point) =>
      point.route_type === "wire" &&
      point.x >= FOCUS_BOUNDS.minX &&
      point.y >= FOCUS_BOUNDS.minY,
  );
  return {
    ...trace,
    route: trace.route.slice(Math.max(0, startIndex)),
  };
};

export const getSample001ViaPairGraphics = ({
  problem,
  targetTrace,
  title,
}: {
  problem: SimpleRouteJson;
  targetTrace: SimplifiedPcbTrace;
  title: string;
}) => {
  const focusedProblem: SimpleRouteJson = {
    ...problem,
    bounds: FOCUS_BOUNDS,
    connections: [],
    obstacles: problem.obstacles.filter((obstacle) => {
      const halfWidth = obstacle.width / 2;
      const halfHeight = obstacle.height / 2;
      return (
        obstacle.center.x + halfWidth >= FOCUS_BOUNDS.minX &&
        obstacle.center.x - halfWidth <= FOCUS_BOUNDS.maxX &&
        obstacle.center.y + halfHeight >= FOCUS_BOUNDS.minY &&
        obstacle.center.y - halfHeight <= FOCUS_BOUNDS.maxY
      );
    }),
  };

  return getPowerTraceGraphics({
    problem: focusedProblem,
    traces: [getFocusedTrace(targetTrace)],
    title,
  });
};

export const getSample001ViaPairReproduction = () => {
  const problem = structuredClone(sample001Input) as unknown as SimpleRouteJson;
  const solver = new PowerTraceExpanderSolver(problem);

  // Stop before cleanup so the reproduction identifies the pipeline stage
  // that created the pair independently of cleanup behavior.
  while (solver.phase !== "cleanup" && !solver.solved && !solver.failed) {
    solver.step();
  }

  const targetTrace = solver
    .getOutput()
    .find((trace) => trace.pcb_trace_id === SAMPLE001_TARGET_TRACE_ID);
  if (!targetTrace) {
    throw new Error(`Missing sample001 trace ${SAMPLE001_TARGET_TRACE_ID}`);
  }

  return {
    problem,
    solver,
    targetTrace,
    graphics: getSample001ViaPairGraphics({
      problem,
      targetTrace,
      title: "sample001 before cleanup: unnecessary via pair",
    }),
  };
};
