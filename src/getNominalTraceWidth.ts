import type {
  SimpleRouteConnection,
  SimpleRouteJson,
  SimplifiedPcbTrace,
} from "./types";

type WidthDefaults = Pick<SimpleRouteJson, "minTraceWidth" | "nominalTraceWidth">;

export function getRequestedTraceWidth(
  problem: WidthDefaults,
  trace: SimplifiedPcbTrace,
  connection: SimpleRouteConnection | undefined,
): number {
  return (
    trace.nominalTraceWidth ??
    connection?.nominalTraceWidth ??
    connection?.width ??
    problem.nominalTraceWidth ??
    problem.minTraceWidth
  );
}

export function getNominalTraceWidth(
  problem: WidthDefaults,
  trace: SimplifiedPcbTrace,
  connection: SimpleRouteConnection | undefined,
): number {
  return Math.max(
    getRequestedTraceWidth(problem, trace, connection),
    problem.minTraceWidth,
  );
}
