import { expect, test } from "bun:test";
import "bun-match-svg";
import {
  getSvgFromGraphicsObject,
  stackGraphicsHorizontally,
} from "graphics-debug";
import { simplifiedCases } from "../fixtures/simplified-cases";
import {
  PowerTraceCleanupSolver,
  PowerTraceExpanderSolver,
  type PowerTraceExpanderInput,
} from "../src";
import type { SimplifiedPcbTrace } from "../src/types";

const wire = (x: number, y: number, layer = "top") => ({
  route_type: "wire" as const,
  x,
  y,
  width: 0.15,
  layer,
});

const inputWithImmutableVia = (): PowerTraceExpanderInput => {
  const input = structuredClone(simplifiedCases.straightClear);
  input.connections[0]!.pointsToConnect = [wire(-2, 2), wire(2, 2)];
  input.traces![0]!.route = [wire(-2, 2), wire(2, 2)];
  input.traces!.push({
    type: "pcb_trace",
    pcb_trace_id: "imported|child:via",
    connection_name: "CHILD",
    route: [
      wire(0, 0),
      {
        route_type: "via",
        x: 0,
        y: 0,
        from_layer: "top",
        to_layer: "bottom",
        via_diameter: 0.6,
        via_hole_diameter: 0.3,
      },
      wire(0, 0, "bottom"),
      wire(1, 0, "bottom"),
    ],
  });
  return input;
};

// Exercise the public parent/child finalization boundary: even a child that
// returns electrically connected copper must not add debt around an imported via.
const finalizeCandidate = (
  solver: PowerTraceExpanderSolver,
  candidate: SimplifiedPcbTrace[],
) => {
  class CandidateCleanup extends PowerTraceCleanupSolver {
    override getOutput() {
      return structuredClone(candidate);
    }
  }
  solver.phase = "cleanup";
  solver.activeSubSolver = new CandidateCleanup({
    simpleRouteJson: solver.inputProblem,
    traces: solver.getOutput(),
  });
  solver.tryFinalAcceptance();
};

test("rejects a new collider even when an immutable via already has a violation", () => {
  const input = inputWithImmutableVia();
  input.obstacles.push({
    type: "rect",
    center: { x: 0, y: 0 },
    width: 0.4,
    height: 0.4,
    layers: ["top"],
    connectedTo: ["CHILD"],
  });
  const solver = new PowerTraceExpanderSolver(input);
  const original = solver.getOutput();
  const candidate = structuredClone(original);
  candidate[0]!.route = [wire(-2, 2), wire(-1, 0), wire(1, 0), wire(2, 2)];

  finalizeCandidate(solver, candidate);

  expect(solver.initialImmutableViaViolationCount).toBe(1);
  expect(solver.initialImmutableViaViolationPairCount).toBe(1);
  expect(solver.attemptedImmutableViaViolationPairCount).toBeGreaterThan(1);
  expect(solver.immutableViaViolationRollbackCount).toBe(1);
  expect(solver.connectivityRollbackCount).toBe(0);
  expect(solver.getOutput()).toEqual(original);
});

test("rejects a replacement collider when the total violation count stays equal", async () => {
  const input = inputWithImmutableVia();
  input.traces![0]!.route = [wire(-2, 2), wire(-1, 0), wire(1, 0), wire(2, 2)];
  input.connections.push({
    name: "SECOND",
    nominalTraceWidth: 0.8,
    pointsToConnect: [wire(-2, -2), wire(2, -2)],
  });
  input.traces!.push({
    type: "pcb_trace",
    pcb_trace_id: "second-owned-trace",
    connection_name: "SECOND",
    route: [wire(-2, -2), wire(2, -2)],
  });
  const solver = new PowerTraceExpanderSolver(input);
  const original = solver.getOutput();
  const candidate = structuredClone(original);
  // The old collider clears the via, but a different owned trace collides.
  // Counting affected vias or collision pairs alone misses the replacement.
  candidate[0]!.route = [wire(-2, 2), wire(2, 2)];
  candidate[2]!.route = [wire(-2, -2), wire(-1, 0), wire(1, 0), wire(2, -2)];

  finalizeCandidate(solver, candidate);

  expect(solver.initialImmutableViaViolationCount).toBe(1);
  expect(solver.initialImmutableViaViolationPairCount).toBeGreaterThan(0);
  expect(solver.attemptedImmutableViaViolationCount).toBe(1);
  expect(solver.attemptedImmutableViaViolationPairCount).toBe(
    solver.initialImmutableViaViolationPairCount,
  );
  expect(solver.immutableViaViolationRollbackCount).toBe(1);
  expect(solver.immutableViaViolationRegressionIds.length).toBeGreaterThan(0);
  expect(solver.connectivityRollbackCount).toBe(0);
  expect(solver.getOutput()).toEqual(original);

  const panels = [original, candidate, solver.getOutput()].map(
    (traces, index) => ({
      coordinateSystem: "cartesian" as const,
      lines: traces.flatMap((trace, traceIndex) =>
        trace.route.flatMap((start, pointIndex) => {
          const end = trace.route[pointIndex + 1];
          if (start.route_type !== "wire" || end?.route_type !== "wire")
            return [];
          return [
            {
              points: [start, end],
              strokeWidth: start.width,
              strokeColor: ["#2563eb", "#64748b", "#dc2626"][traceIndex],
              strokeDash: start.layer === "bottom" ? "0.08 0.08" : undefined,
            },
          ];
        }),
      ),
      circles: traces.flatMap((trace) =>
        trace.route.flatMap((point) =>
          point.route_type === "via"
            ? [
                {
                  center: point,
                  radius: point.via_diameter! / 2,
                  fill: "#fbbf24",
                  stroke: "#92400e",
                },
              ]
            : [],
        ),
      ),
      texts: [
        "Blue: POWER; red: SECOND; gold: imported via",
        index === 1
          ? "New SECOND collider replaces POWER"
          : "Existing POWER collision remains",
        `Affected vias: ${index === 1 ? solver.attemptedImmutableViaViolationCount : solver.initialImmutableViaViolationCount}; violation pairs: ${index === 1 ? solver.attemptedImmutableViaViolationPairCount : solver.initialImmutableViaViolationPairCount}`,
        index === 1
          ? "Equal counts hide a different offending object"
          : index === 2
            ? "New collision signature triggers rollback"
            : "Baseline debt does not permit new collisions",
      ].map((text, row) => ({
        x: -2.4,
        y: -2.6 - row * 0.5,
        text,
        fontSize: 0.22,
        anchorSide: "center_left" as const,
        color: "#334155",
      })),
    }),
  );
  await expect(
    getSvgFromGraphicsObject(
      stackGraphicsHorizontally(panels, {
        titles: ["Accepted input", "Rejected replacement", "Accepted output"],
      }),
      { backgroundColor: "white", svgWidth: 1500, svgHeight: 650 },
    ).replace(/[ \t]+$/gm, ""),
  ).toMatchSvgSnapshot(import.meta.path);
});

test("preserves existing immutable-via debt and counts opaque IDs independently", () => {
  const input = inputWithImmutableVia();
  const otherChild = structuredClone(input.traces![1]!);
  otherChild.pcb_trace_id = "imported|other:via";
  for (const point of otherChild.route) {
    if (point.route_type === "wire" || point.route_type === "via") point.x += 2;
  }
  input.traces!.push(otherChild);
  input.obstacles = [0, 2].map((x) => ({
    type: "rect",
    center: { x, y: 0 },
    width: 0.4,
    height: 0.4,
    layers: ["top"],
    connectedTo: ["CHILD"],
  }));

  const solver = new PowerTraceExpanderSolver(input);

  expect(solver.initialImmutableViaViolationCount).toBe(2);
  expect(solver.initialImmutableViaViolationPairCount).toBe(2);

  solver.solve();

  expect(solver.getOutput().slice(1)).toEqual(input.traces!.slice(1));
  expect(solver.remainingImmutableViaViolationCount).toBe(2);
  expect(solver.immutableViaViolationRollbackCount).toBe(0);
  expect(solver.stats.resultStatus).toBe("best_effort");
  expect(solver.stats.completionReason).toBe(
    "immutable_via_violations_preserved",
  );
});
