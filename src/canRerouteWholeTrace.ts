import type { ConnectionNameResolver } from "./ConnectionNameResolver";
import { pointsEqual, WIDTH_EPSILON } from "./geometry";
import type {
  PowerTraceExpanderInput,
  SimpleRouteConnection,
  SimplifiedPcbTrace,
} from "./types";

type WholeTraceRerouteEligibilityInput = {
  trace: SimplifiedPcbTrace;
  connection: SimpleRouteConnection;
  nominalTraceWidth: number;
  traces: readonly SimplifiedPcbTrace[];
  inputProblem: PowerTraceExpanderInput;
  connectionNameResolver: ConnectionNameResolver;
};

export const canRerouteWholeTrace = ({
  trace,
  connection,
  nominalTraceWidth,
  traces,
  inputProblem,
  connectionNameResolver,
}: WholeTraceRerouteEligibilityInput): boolean => {
  // A two-endpoint search cannot preserve intermediate pad or branch contacts.
  if (connection.pointsToConnect.length !== 2) return false;
  const start = trace.route[0];
  const end = trace.route.at(-1);
  if (start?.route_type !== "wire" || end?.route_type !== "wire") return false;
  const [firstTerminal, secondTerminal] = connection.pointsToConnect;
  const endpointsMatch =
    (pointsEqual(start, firstTerminal!) && pointsEqual(end, secondTerminal!)) ||
    (pointsEqual(start, secondTerminal!) && pointsEqual(end, firstTerminal!));
  if (!endpointsMatch) return false;
  if (
    trace.route.some(
      (point) => point.route_type !== "wire" && point.route_type !== "via",
    )
  ) {
    return false;
  }

  const [netName] = connectionNameResolver.canonicalize([trace.pcb_trace_id]);
  for (const otherTrace of [...traces, ...(inputProblem.fixedTraces ?? [])]) {
    if (otherTrace === trace) continue;
    if (
      connectionNameResolver
        .canonicalize([otherTrace.pcb_trace_id])
        .includes(netName!)
    ) {
      return false;
    }
  }
  // Separate stacked SMT pads cannot provide a through-hole layer transition.
  let startPadFound = false;
  let endPadFound = false;
  for (const obstacle of inputProblem.obstacles) {
    const connected = connectionNameResolver
      .canonicalize(obstacle.connectedTo)
      .includes(netName!);
    if (!connected) continue;
    if (
      Math.min(obstacle.width, obstacle.height) <
      nominalTraceWidth - WIDTH_EPSILON
    ) {
      return false;
    }
    if (pointsEqual(start, obstacle.center)) {
      if (startPadFound) return false;
      startPadFound = true;
    } else if (pointsEqual(end, obstacle.center)) {
      if (endPadFound) return false;
      endPadFound = true;
    } else {
      return false;
    }
  }
  return startPadFound && endPadFound;
};
