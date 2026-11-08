import { PhysicalConnectivityInvariant } from "./PhysicalConnectivityInvariant";
import type { PowerTraceExpanderInput, SimplifiedPcbTrace } from "./types";

/** Remove out-and-back copper only when it has no required electrical contact. */
export function removeUnusedTraceBacktracks(
  input: PowerTraceExpanderInput,
  traces: SimplifiedPcbTrace[],
  immutableTraceIndices: ReadonlySet<number>,
): { traces: SimplifiedPcbTrace[]; removedCount: number } {
  let current = traces;
  let removedCount = 0;
  let invariant: PhysicalConnectivityInvariant | undefined;
  for (let traceIndex = 0; traceIndex < current.length; traceIndex++) {
    if (immutableTraceIndices.has(traceIndex)) continue;
    for (let i = 1; i + 1 < current[traceIndex]!.route.length; i++) {
      const route = current[traceIndex]!.route;
      const a = route[i - 1]!,
        b = route[i]!,
        c = route[i + 1]!;
      if (
        a.route_type !== "wire" ||
        b.route_type !== "wire" ||
        c.route_type !== "wire" ||
        a.layer !== b.layer ||
        b.layer !== c.layer ||
        a.width !== b.width ||
        b.start_pcb_port_id ||
        b.end_pcb_port_id
      )
        continue;
      const ax = b.x - a.x,
        ay = b.y - a.y,
        bx = c.x - b.x,
        by = c.y - b.y;
      if (
        ax * bx + ay * by >= 0 ||
        Math.abs(ax * by - ay * bx) >
          1e-8 * Math.max(Math.hypot(ax, ay), Math.hypot(bx, by))
      )
        continue;
      invariant ??= new PhysicalConnectivityInvariant(input, current);
      const candidate = current.slice();
      candidate[traceIndex] = {
        ...current[traceIndex]!,
        route: [...route.slice(0, i), ...route.slice(i + 1)],
      };
      const validation = invariant.validate(candidate);
      if (validation.validationError)
        throw new Error(validation.validationError);
      // A junction on the removed leg is useful copper, even though this
      // individual trace doubles back. Preserve it when another route needs it.
      if (!validation.safe) continue;
      current = candidate;
      removedCount++;
      i = Math.max(0, i - 2);
    }
  }
  return { traces: current, removedCount };
}
