import type {
  SimpleRouteConnection,
  SimpleRouteJson,
  SimplifiedPcbTrace,
} from "@tscircuit/core";
import rp2040DualMotorProblem from "../fixtures/rp2040-dual-motor/input.json";
import {
  ConnectionNameResolver,
  PowerTraceExpanderSolver,
  SpatialObstacleIndex,
} from "../src";

const problem = structuredClone(
  rp2040DualMotorProblem,
) as unknown as SimpleRouteJson;
const solver = new PowerTraceExpanderSolver(problem);
solver.solve();
if (!solver.solved || solver.failed) throw new Error("Solver did not complete");

const traces = solver.getOutput();
const resolver = new ConnectionNameResolver(problem, traces);
const getTraceNames = (trace: SimplifiedPcbTrace) =>
  [
    trace.connection_name,
    trace.source_trace_id,
    trace.rootConnectionName,
    ...(trace.mergedConnectionNames ?? []),
    ...(trace.connectsTo ?? []),
  ].filter((name): name is string => Boolean(name));
const connectionNames = (connection: SimpleRouteConnection) =>
  [
    connection.name,
    connection.source_trace_id,
    connection.rootConnectionName,
    ...(connection.mergedConnectionNames ?? []),
  ].filter((name): name is string => Boolean(name));
const findConnection = (trace: SimplifiedPcbTrace) => {
  const traceNames = getTraceNames(trace);
  return problem.connections.find((connection) =>
    connectionNames(connection).some((name) => traceNames.includes(name)),
  );
};

const blockerLengths = new Map<string, number>();
const traceDeficits = new Map<
  string,
  { totalLength: number; underLength: number; deficitArea: number }
>();
const widthBins = new Map<string, number>();

for (let traceIndex = 0; traceIndex < traces.length; traceIndex++) {
  const trace = traces[traceIndex]!;
  const connection = findConnection(trace);
  if (!connection) continue;
  const nominalWidth = Math.max(
    connection.nominalTraceWidth ?? connection.width ?? problem.minTraceWidth,
    problem.minTraceWidth,
  );
  if (nominalWidth < 0.99) continue;
  const index = new SpatialObstacleIndex(
    problem,
    traces,
    traceIndex,
    [],
    resolver,
  );
  const traceMetric = traceDeficits.get(connection.name) ?? {
    totalLength: 0,
    underLength: 0,
    deficitArea: 0,
  };
  const names = getTraceNames(trace);

  for (let routeIndex = 0; routeIndex < trace.route.length - 1; routeIndex++) {
    const start = trace.route[routeIndex];
    const end = trace.route[routeIndex + 1];
    if (
      start?.route_type !== "wire" ||
      end?.route_type !== "wire" ||
      start.layer !== end.layer
    )
      continue;
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    const width = start.width;
    traceMetric.totalLength += length;
    if (width >= nominalWidth - 1e-6) continue;
    traceMetric.underLength += length;
    traceMetric.deficitArea += length * (nominalWidth - width);
    const bin =
      width < 0.25
        ? "<0.25"
        : width < 0.5
          ? "0.25-0.499"
          : width < 0.75
            ? "0.5-0.749"
            : width < 0.9
              ? "0.75-0.899"
              : "0.9-0.999";
    widthBins.set(bin, (widthBins.get(bin) ?? 0) + length);

    const query = {
      start,
      end,
      layer: start.layer,
      width: nominalWidth,
      connectionNames: names,
    };
    const collisions = index.findCollisions(query);
    const keys = new Set(
      collisions.map((collision) =>
        collision.kind === "trace" && collision.traceIndex !== undefined
          ? `trace:${traces[collision.traceIndex]?.connection_name ?? collision.traceIndex}`
          : collision.kind,
      ),
    );
    if (keys.size === 0 && index.collides(query)) keys.add("board-edge");
    if (keys.size === 0) keys.add("no-direct-nominal-collision");
    for (const key of keys) {
      blockerLengths.set(key, (blockerLengths.get(key) ?? 0) + length);
    }
  }
  traceDeficits.set(connection.name, traceMetric);
}

const descendingEntries = (map: Map<string, number>) =>
  Object.fromEntries([...map].sort((a, b) => b[1] - a[1]));

console.log(
  JSON.stringify(
    {
      widthBins: descendingEntries(widthBins),
      nominalWidthBlockerLengthsOverlapping: descendingEntries(blockerLengths),
      blockerAttributionNote:
        "Categories overlap and test why full nominal width is blocked, not why the current intermediate width cannot grow.",
      worstConnections: Object.fromEntries(
        [...traceDeficits]
          .sort((a, b) => b[1].deficitArea - a[1].deficitArea)
          .slice(0, 12),
      ),
    },
    null,
    2,
  ),
);
