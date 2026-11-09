import { describe, expect, test } from "bun:test";
import {
  createUpperPMotorAProblem,
  UPPER_P_MOTOR_A_CONNECTION,
} from "../fixtures/rp2040-dual-motor/create-upper-p-motor-a-problem";
import rp2040Input from "../fixtures/rp2040-dual-motor/input.json";
import { simplifiedCases } from "../fixtures/simplified-cases";
import {
  compareSrjBoardDrcSignatures,
  computeSrjBoardDrcSignature,
  DRC_GAP_EPSILON,
  PowerTraceCleanupSolver,
  PowerTraceClearanceRepairSolver,
  PowerTraceExpanderSolver,
  SrjBoardDrcCertificate,
} from "../src";
import type {
  Obstacle,
  SimpleRouteJson,
  SimplifiedPcbTrace,
} from "../src/types";

const wire = (
  x: number,
  y: number,
  width = 0.2,
  layer = "top",
): SimplifiedPcbTrace["route"][number] => ({
  route_type: "wire",
  x,
  y,
  width,
  layer,
});

const via = (
  x: number,
  y: number,
  from_layer = "top",
  to_layer = "bottom",
  via_diameter?: number,
  via_hole_diameter?: number,
): SimplifiedPcbTrace["route"][number] => ({
  route_type: "via",
  x,
  y,
  from_layer,
  to_layer,
  ...(via_diameter !== undefined ? { via_diameter } : {}),
  ...(via_hole_diameter !== undefined ? { via_hole_diameter } : {}),
});

const makeBaseBoard = (
  overrides: Partial<SimpleRouteJson> = {},
): SimpleRouteJson => ({
  layerCount: 2,
  minTraceWidth: 0.15,
  nominalTraceWidth: 0.6,
  defaultObstacleMargin: 0.15,
  minTraceToPadEdgeClearance: 0.15,
  minPadEdgeToPadEdgeClearance: 0.12,
  minTraceToHoleEdgeClearance: 0.25,
  minBoardEdgeClearance: 0.2,
  minViaHoleEdgeToViaHoleEdgeClearance: 0.2,
  minViaPadDiameter: 0.6,
  minViaHoleDiameter: 0.3,
  bounds: { minX: -10, maxX: 10, minY: -10, maxY: 10 },
  connections: [
    {
      name: "VCC",
      nominalTraceWidth: 0.6,
      pointsToConnect: [
        { x: -6, y: 0, layer: "top" },
        { x: 6, y: 0, layer: "top" },
      ],
    },
  ],
  obstacles: [],
  fixedTraces: [],
  traces: [
    {
      type: "pcb_trace",
      pcb_trace_id: "trace_vcc",
      connection_name: "VCC",
      route: [wire(-6, 0, 0.2, "top"), wire(6, 0, 0.2, "top")],
    },
  ],
  ...overrides,
});

const createMulberry32 = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

describe("SrjBoardDrcCertificate — violation detection & valid boards", () => {
  test("valid board covering all supported SRJ primitives remains valid through full solve", () => {
    const board = makeBaseBoard({
      obstacles: [
        // Same-net start/end rectangular pads
        {
          type: "rect",
          obstacleId: "pad_vcc_start",
          center: { x: -6, y: 0 },
          width: 1.0,
          height: 1.0,
          layers: ["top"],
          connectedTo: ["VCC", "pcb_smtpad_vcc_start"],
        },
        {
          type: "rect",
          obstacleId: "pad_vcc_end",
          center: { x: 6, y: 0 },
          width: 1.0,
          height: 1.0,
          layers: ["top"],
          connectedTo: ["VCC", "pcb_smtpad_vcc_end"],
        },
        // Rotated rect obstacle on another net
        {
          type: "rect",
          obstacleId: "pad_rot_other",
          center: { x: -2, y: 1.6 },
          width: 1.4,
          height: 0.6,
          ccwRotationDegrees: 35,
          layers: ["top"],
          connectedTo: ["GND", "pcb_smtpad_rot"],
        },
        // Explicit circle shape pad
        {
          type: "rect",
          shape: "circle",
          obstacleId: "pad_circle_other",
          center: { x: 0, y: -1.6 },
          width: 0.9,
          height: 0.9,
          layers: ["top"],
          connectedTo: ["SIG_A", "pcb_plated_hole_1"],
        },
        // Circular oval pad (emitted by @tscircuit/core SRJ)
        {
          type: "oval" as unknown as "rect",
          obstacleId: "pad_oval_other",
          center: { x: 2.5, y: 1.6 },
          width: 0.8,
          height: 0.8,
          layers: ["top", "bottom"],
          connectedTo: ["SIG_B", "pcb_plated_hole_2"],
        },
        // Non-plated mechanical hole
        {
          type: "rect",
          shape: "circle",
          obstacleId: "npth_mount",
          center: { x: 4, y: -2.0 },
          width: 1.2,
          height: 1.2,
          layers: ["top", "bottom"],
          connectedTo: [],
          isNonPlatedHole: true,
        },
        // Different-net copper pour
        {
          type: "rect",
          obstacleId: "gnd_pour",
          center: { x: 0, y: 5.5 },
          width: 8,
          height: 2,
          layers: ["top"],
          connectedTo: ["GND"],
          isCopperPour: true,
        },
      ],
      fixedTraces: [
        {
          type: "pcb_trace",
          pcb_trace_id: "fixed_gnd_guard",
          connection_name: "GND",
          route: [wire(-6, -3.2, 0.25, "top"), wire(6, -3.2, 0.25, "top")],
        },
      ],
      traces: [
        {
          type: "pcb_trace",
          pcb_trace_id: "trace_vcc",
          connection_name: "VCC",
          route: [wire(-6, 0, 0.2, "top"), wire(6, 0, 0.2, "top")],
        },
        // Two same-net subtraces sharing one coincident physical through-via site
        {
          type: "pcb_trace",
          pcb_trace_id: "trace_sig_branch_1",
          connection_name: "SIG_SHARED",
          route: [
            wire(-6, 3.0, 0.16, "top"),
            wire(-4, 3.0, 0.16, "top"),
            via(-4, 3.0, "top", "bottom", 0.6, 0.3),
            wire(-4, 3.0, 0.16, "bottom"),
            wire(-2, 3.0, 0.16, "bottom"),
          ],
        },
        {
          type: "pcb_trace",
          pcb_trace_id: "trace_sig_branch_2",
          connection_name: "SIG_SHARED",
          route: [
            wire(-4, 3.0, 0.16, "top"),
            via(-4, 3.0, "top", "bottom", 0.6, 0.3),
            wire(-4, 4.2, 0.16, "top"),
          ],
        },
      ],
    });

    const initialSig = computeSrjBoardDrcSignature(board);
    expect(initialSig.violations).toHaveLength(0);
    expect(initialSig.hasUnsupportedGeometry).toBe(false);

    const solver = new PowerTraceExpanderSolver(board);
    solver.solve();

    const output = solver.getOutput();
    const finalSig = computeSrjBoardDrcSignature(board, output);
    const comparison = compareSrjBoardDrcSignatures(initialSig, finalSig);

    expect(solver.solved).toBe(true);
    expect(comparison.safe).toBe(true);
    expect(finalSig.violations).toHaveLength(0);
    expect(solver.stats.drcCertificateStatus).toBe("certified");
    expect(solver.stats.drcRollbackCount).toBe(0);
    expect(solver.stats.drcValidationCount).toBeGreaterThanOrEqual(3);
    // Boundary-only check: validations scale with phase boundaries, not operations
    expect(solver.stats.drcValidationCount).toBeLessThanOrEqual(
      solver.completedPassCount + 4,
    );
  });

  test("detects all 7 SRJ DRC violation categories with deterministic canonical keys", () => {
    // 1. different_net_short + copper_clearance on crossing traces
    const shortBoard = makeBaseBoard({
      traces: [
        {
          type: "pcb_trace",
          pcb_trace_id: "t_a",
          connection_name: "NET_A",
          route: [wire(-3, 0, 0.2, "top"), wire(3, 0, 0.2, "top")],
        },
        {
          type: "pcb_trace",
          pcb_trace_id: "t_b",
          connection_name: "NET_B",
          route: [wire(0, -3, 0.2, "top"), wire(0, 3, 0.2, "top")],
        },
      ],
    });
    const shortSig = computeSrjBoardDrcSignature(shortBoard);
    expect(shortSig.violationCountByKind.different_net_short).toBe(1);
    expect(shortSig.violationCountByKind.copper_clearance).toBe(1);
    expect(
      shortSig.violationsById.has(
        "different_net_short|top|trace:t_a|trace:t_b",
      ),
    ).toBe(true);
    expect(
      shortSig.violationsById.get(
        "different_net_short|top|trace:t_a|trace:t_b",
      )!.gap,
    ).toBeCloseTo(-0.2, 6);

    // 2. copper_clearance against rotated rect, circle, pour, non-plated hole, via-via, and fixedTraces
    const clearanceBoard = makeBaseBoard({
      obstacles: [
        {
          type: "rect",
          obstacleId: "rot_pad",
          center: { x: -4, y: 0.48 },
          width: 1.0,
          height: 0.4,
          ccwRotationDegrees: 45,
          layers: ["top"],
          connectedTo: ["OTHER_1", "pcb_smtpad_1"],
        },
        {
          type: "rect",
          shape: "circle",
          obstacleId: "hole_1",
          center: { x: 0, y: 0.6 },
          width: 0.8,
          height: 0.8,
          layers: ["top", "bottom"],
          connectedTo: [],
          isNonPlatedHole: true,
        },
        {
          type: "rect",
          obstacleId: "pour_1",
          center: { x: 4, y: 0.45 },
          width: 1.2,
          height: 0.6,
          layers: ["top"],
          connectedTo: ["OTHER_2"],
          isCopperPour: true,
        },
      ],
      fixedTraces: [
        {
          type: "pcb_trace",
          pcb_trace_id: "fixed_1",
          connection_name: "OTHER_3",
          route: [wire(-6, -0.28, 0.2, "top"), wire(-5, -0.28, 0.2, "top")],
        },
      ],
      traces: [
        {
          type: "pcb_trace",
          pcb_trace_id: "t_main",
          connection_name: "VCC",
          // Overlaps hole_1 slightly if widened, here gap to hole_1 is 0.6 - 0.4 - 0.1 = 0.10 < 0.25 holeClearance
          route: [wire(-6, 0, 0.2, "top"), wire(6, 0, 0.2, "top")],
        },
      ],
    });
    const clearanceSig = computeSrjBoardDrcSignature(clearanceBoard);
    expect(
      clearanceSig.violationsById.has(
        "copper_clearance|top|obstacle:rot_pad|trace:t_main",
      ),
    ).toBe(true);
    expect(
      clearanceSig.violationsById.has(
        "copper_clearance|top|obstacle:hole_1|trace:t_main",
      ),
    ).toBe(true);
    expect(
      clearanceSig.violationsById.has(
        "copper_clearance|top|obstacle:pour_1|trace:t_main",
      ),
    ).toBe(true);
    expect(
      clearanceSig.violationsById.has(
        "copper_clearance|top|fixed_trace:fixed_1|trace:t_main",
      ),
    ).toBe(true);
    // Non-plated hole overlap must NEVER be misclassified as conductive different_net_short
    const holeOverlapBoard = structuredClone(clearanceBoard);
    holeOverlapBoard.obstacles[1]!.center = { x: 0, y: 0 };
    const holeOverlapSig = computeSrjBoardDrcSignature(holeOverlapBoard);
    expect(
      holeOverlapSig.violationsById.has(
        "copper_clearance|top|obstacle:hole_1|trace:t_main",
      ),
    ).toBe(true);
    expect(
      holeOverlapSig.violationsById.has(
        "different_net_short|top|obstacle:hole_1|trace:t_main",
      ),
    ).toBe(false);

    // 3, 4, 5. via_annulus, via_drill_spacing, same_net_via_spacing, and via-to-via copper clearance
    const viaBoard = makeBaseBoard({
      minViaPadDiameter: 0.6,
      minViaHoleDiameter: 0.3, // minViaAnnulus = 0.15
      minViaHoleEdgeToViaHoleEdgeClearance: 0.25,
      minPadEdgeToPadEdgeClearance: 0.18,
      traces: [
        {
          type: "pcb_trace",
          pcb_trace_id: "vcc_vias",
          connection_name: "VCC",
          route: [
            wire(-2, 0, 0.2, "top"),
            // Undersized annulus: (0.42 - 0.3) / 2 = 0.06 < 0.15
            via(-2, 0, "top", "bottom", 0.42, 0.3),
            wire(-1.6, 0, 0.2, "bottom"),
            // Distinct same-net via at dx=0.4 -> drill gap = 0.4 - 0.3 = 0.10 < 0.25
            via(-1.6, 0, "bottom", "top", 0.6, 0.3),
            wire(-1.0, 0, 0.2, "top"),
          ],
        },
        {
          type: "pcb_trace",
          pcb_trace_id: "gnd_via",
          connection_name: "GND",
          route: [
            wire(-0.9, 0, 0.2, "top"),
            // Different-net via 0.70mm from (-1.6, 0):
            // drill gap = 0.70 - 0.30 = 0.40 >= 0.25 (drill ok),
            // pad gap = 0.70 - 0.60 = 0.10 < 0.18 (via-to-via copper clearance violation!)
            via(-0.9, 0, "top", "bottom", 0.6, 0.3),
            wire(-0.9, 1, 0.2, "bottom"),
            // Second different-net via 0.45mm from (-2, 0):
            // drill gap = 0.45 - 0.30 = 0.15 < 0.25 (via_drill_spacing violation!)
            via(-2, 0.45, "bottom", "top", 0.6, 0.3),
          ],
        },
      ],
    });
    const viaSig = computeSrjBoardDrcSignature(viaBoard);
    expect(viaSig.violationCountByKind.via_annulus).toBe(1);
    expect(viaSig.violationCountByKind.same_net_via_spacing).toBe(1);
    expect(viaSig.violationCountByKind.via_drill_spacing).toBe(1);
    expect(
      viaSig.violations.some(
        (v) =>
          v.kind === "copper_clearance" &&
          v.objectIdA.startsWith("via:") &&
          v.objectIdB.startsWith("via:"),
      ),
    ).toBe(true);

    // 6. board_edge_clearance on all four edges
    const edgeBoard = makeBaseBoard({
      bounds: { minX: -5, maxX: 5, minY: -5, maxY: 5 },
      minBoardEdgeClearance: 0.3,
      traces: [
        {
          type: "pcb_trace",
          pcb_trace_id: "edge_ring",
          connection_name: "VCC",
          route: [
            wire(-4.85, -4.85, 0.2, "top"),
            wire(4.85, -4.85, 0.2, "top"),
            wire(4.85, 4.85, 0.2, "top"),
            wire(-4.85, 4.85, 0.2, "top"),
          ],
        },
      ],
    });
    const edgeSig = computeSrjBoardDrcSignature(edgeBoard);
    expect(edgeSig.violationCountByKind.board_edge_clearance).toBe(4);
    expect(
      edgeSig.violationsById.has(
        "board_edge_clearance|top|board_edge:minX|trace:edge_ring",
      ),
    ).toBe(true);
    expect(
      edgeSig.violationsById.has(
        "board_edge_clearance|top|board_edge:maxX|trace:edge_ring",
      ),
    ).toBe(true);
    expect(
      edgeSig.violationsById.has(
        "board_edge_clearance|top|board_edge:minY|trace:edge_ring",
      ),
    ).toBe(true);
    expect(
      edgeSig.violationsById.has(
        "board_edge_clearance|top|board_edge:maxY|trace:edge_ring",
      ),
    ).toBe(true);
  });

  test("unsupported or malformed legal geometry fails closed without crashing", () => {
    const unsupportedCases: Array<[string, SimpleRouteJson]> = [
      [
        "jumper route point",
        makeBaseBoard({
          traces: [
            {
              type: "pcb_trace",
              pcb_trace_id: "t_jumper",
              connection_name: "VCC",
              route: [
                wire(-6, 0, 0.2, "top"),
                {
                  route_type: "jumper",
                  start: { x: -2, y: 0 },
                  end: { x: 2, y: 0 },
                  footprint: "0603",
                  layer: "top",
                },
                wire(6, 0, 0.2, "top"),
              ],
            },
          ],
        }),
      ],
      [
        "non-circular oval obstacle",
        makeBaseBoard({
          obstacles: [
            {
              type: "oval" as unknown as "rect",
              obstacleId: "oblong_pad",
              center: { x: 0, y: 2 },
              width: 1.6,
              height: 0.7,
              layers: ["top"],
              connectedTo: ["GND"],
            },
          ],
        }),
      ],
      [
        "through_obstacle primitive",
        makeBaseBoard({
          obstacles: [
            {
              type: "through_obstacle" as unknown as "rect",
              obstacleId: "keepout_1",
              center: { x: 0, y: 2 },
              width: 1,
              height: 1,
              layers: ["top"],
              connectedTo: [],
            },
          ],
        }),
      ],
      [
        "non-finite wire coordinate",
        makeBaseBoard({
          traces: [
            {
              type: "pcb_trace",
              pcb_trace_id: "t_nan",
              connection_name: "VCC",
              route: [wire(Number.NaN, 0, 0.2, "top"), wire(6, 0, 0.2, "top")],
            },
          ],
        }),
      ],
      [
        "invalid layer & non-positive width",
        makeBaseBoard({
          traces: [
            {
              type: "pcb_trace",
              pcb_trace_id: "t_bad_layer",
              connection_name: "VCC",
              route: [wire(-6, 0, 0, "inner99"), wire(6, 0, 0.2, "top")],
            },
          ],
        }),
      ],
    ];

    for (const [label, problem] of unsupportedCases) {
      const originalTraces = structuredClone(problem.traces ?? []);
      const sig = computeSrjBoardDrcSignature(problem);
      expect(sig.hasUnsupportedGeometry).toBe(true);
      expect(sig.violationCountByKind.unsupported_geometry).toBeGreaterThan(0);

      // Exact preservation passes; any mutation fails closed
      expect(compareSrjBoardDrcSignatures(sig, sig).safe).toBe(true);
      const mutatedTraces = structuredClone(originalTraces);
      if (mutatedTraces[0]?.route[0]?.route_type === "wire") {
        mutatedTraces[0].route[0].width = 0.5;
      } else {
        mutatedTraces.push({
          type: "pcb_trace",
          pcb_trace_id: "extra",
          connection_name: "VCC",
          route: [wire(-1, -1, 0.2, "top"), wire(1, -1, 0.2, "top")],
        });
      }
      const mutatedSig = computeSrjBoardDrcSignature(problem, mutatedTraces);
      const cmp = compareSrjBoardDrcSignatures(sig, mutatedSig);
      expect(cmp.safe).toBe(false);
      expect(
        cmp.regressions.some((r) => r.reason === "unsupported_geometry"),
      ).toBe(true);

      // End-to-end solver must never crash and must preserve input traces byte-for-byte
      const solver = new PowerTraceExpanderSolver(problem);
      expect(() => solver.solve()).not.toThrow();
      expect(solver.solved).toBe(true);
      expect(solver.failed).toBe(false);
      expect(solver.getOutput()).toEqual(originalTraces);
      expect(solver.stats.drcCertificateStatus).toBe(
        "unsupported_geometry_fail_closed",
      );
      expect(solver.stats.completionReason).toBe("unsupported_geometry");
      expect(label.length).toBeGreaterThan(0);
    }
  });
});

describe("SrjBoardDrcCertificate — already-invalid boards & gap monotonicity", () => {
  test("accepts partial repairs (including short -> tight clearance) and rejects gap worsening", () => {
    const board = makeBaseBoard({
      minTraceToPadEdgeClearance: 0.15,
      defaultObstacleMargin: 0.15,
      obstacles: [
        {
          type: "rect",
          obstacleId: "aggressor_pad",
          center: { x: 0, y: 0.45 },
          width: 0.8,
          height: 0.8, // bottom edge at y = 0.05
          layers: ["top"],
          connectedTo: ["OTHER_NET", "pcb_smtpad_aggressor"],
        },
      ],
      traces: [
        {
          type: "pcb_trace",
          pcb_trace_id: "victim_trace",
          connection_name: "VCC",
          // radius = 0.10 -> top edge at y = 0.10 -> overlaps pad bottom (0.05) by -0.05mm!
          route: [wire(-5, 0, 0.2, "top"), wire(5, 0, 0.2, "top")],
        },
      ],
    });

    const baseline = computeSrjBoardDrcSignature(board);
    expect(baseline.violationCountByKind.different_net_short).toBe(1);
    expect(baseline.violationCountByKind.copper_clearance).toBe(1);

    // Candidate 1: narrow trace to width=0.04 (radius=0.02) -> gap becomes +0.03 (< 0.15 clearance, but no longer short!)
    const partiallyRepaired = structuredClone(board.traces!);
    for (const pt of partiallyRepaired[0]!.route) {
      if (pt.route_type === "wire") pt.width = 0.04;
    }
    const partialSig = computeSrjBoardDrcSignature(board, partiallyRepaired);
    const partialCmp = compareSrjBoardDrcSignatures(baseline, partialSig);
    expect(partialCmp.safe).toBe(true);
    expect(partialCmp.resolvedViolationIds).toContain(
      "different_net_short|top|obstacle:aggressor_pad|trace:victim_trace",
    );

    // Candidate 2: shift trace 5e-7 mm closer (within DRC_GAP_EPSILON = 1e-6) -> tolerated
    const withinEpsilon = structuredClone(board.traces!);
    for (const pt of withinEpsilon[0]!.route) {
      if (pt.route_type === "wire") pt.y += DRC_GAP_EPSILON * 0.4;
    }
    expect(
      compareSrjBoardDrcSignatures(
        baseline,
        computeSrjBoardDrcSignaturesHelper(board, withinEpsilon),
      ).safe,
    ).toBe(true);

    // Candidate 3: shift trace 5e-6 mm closer (exceeds DRC_GAP_EPSILON) -> rejected as worsened_gap!
    const worsened = structuredClone(board.traces!);
    for (const pt of worsened[0]!.route) {
      if (pt.route_type === "wire") pt.y += DRC_GAP_EPSILON * 5;
    }
    const worsenedCmp = compareSrjBoardDrcSignatures(
      baseline,
      computeSrjBoardDrcSignature(board, worsened),
    );
    expect(worsenedCmp.safe).toBe(false);
    expect(worsenedCmp.worsenedViolations).toHaveLength(2);
    expect(worsenedCmp.regressions[0]?.reason).toBe("worsened_gap");
  });

  test("solver expands power trace on an already-invalid board without adding or worsening violations", () => {
    const board = makeBaseBoard({
      connections: [
        {
          name: "VCC",
          nominalTraceWidth: 0.6,
          pointsToConnect: [
            { x: -6, y: -3, layer: "top" },
            { x: 6, y: -3, layer: "top" },
          ],
        },
      ],
      obstacles: [
        {
          type: "rect",
          obstacleId: "unrelated_tight_pad",
          center: { x: 0, y: 4.18 },
          width: 0.4,
          height: 0.4, // bottom at y = 3.98 -> 0.08mm gap to unrelated_sig (< 0.15)
          layers: ["top"],
          connectedTo: ["NET_X", "pcb_smtpad_x"],
        },
      ],
      traces: [
        {
          type: "pcb_trace",
          pcb_trace_id: "trace_vcc",
          connection_name: "VCC",
          route: [wire(-6, -3, 0.2, "top"), wire(6, -3, 0.2, "top")],
        },
        // Pre-existing invalid unrelated signal trace with tight pad clearance AND crossing short
        {
          type: "pcb_trace",
          pcb_trace_id: "unrelated_sig_1",
          connection_name: "SIG_1",
          route: [wire(-4, 3.8, 0.2, "top"), wire(4, 3.8, 0.2, "top")],
        },
        {
          type: "pcb_trace",
          pcb_trace_id: "unrelated_sig_2",
          connection_name: "SIG_2",
          route: [wire(2, 3.0, 0.2, "top"), wire(2, 4.6, 0.2, "top")],
        },
      ],
    });

    const initialSig = computeSrjBoardDrcSignature(board);
    expect(initialSig.violations.length).toBeGreaterThanOrEqual(3);

    const solver = new PowerTraceExpanderSolver(board, {
      onlyConnectionNames: ["VCC"],
    });
    solver.solve();

    const output = solver.getOutput();
    const finalSig = computeSrjBoardDrcSignature(board, output);
    const cmp = compareSrjBoardDrcSignatures(initialSig, finalSig);

    expect(cmp.safe).toBe(true);
    expect(solver.stats.drcRollbackCount).toBe(0);
    const vccWires = output[0]!.route.filter((pt) => pt.route_type === "wire");
    expect(vccWires.every((pt) => pt.width >= 0.6 - 1e-6)).toBe(true);
  });
});

function computeSrjBoardDrcSignaturesHelper(
  board: SimpleRouteJson,
  traces: SimplifiedPcbTrace[],
) {
  return computeSrjBoardDrcSignature(board, traces);
}

describe("SrjBoardDrcCertificate — equal-count violation swaps & rollback stats separation", () => {
  test("compareSrjBoardDrcSignatures rejects equal-count swaps across pads, layers, and board edges", () => {
    const board = makeBaseBoard({
      bounds: { minX: -5, maxX: 5, minY: -5, maxY: 5 },
      minBoardEdgeClearance: 0.3,
      obstacles: [
        {
          type: "rect",
          obstacleId: "pad_left",
          center: { x: -3, y: 0.2 },
          width: 0.4,
          height: 0.4,
          layers: ["top"],
          connectedTo: ["NET_L", "pcb_smtpad_l"],
        },
        {
          type: "rect",
          obstacleId: "pad_right",
          center: { x: 3, y: -2.2 },
          width: 0.4,
          height: 0.4,
          layers: ["top"],
          connectedTo: ["NET_R", "pcb_smtpad_r"],
        },
      ],
      traces: [
        {
          type: "pcb_trace",
          pcb_trace_id: "t_swap",
          connection_name: "VCC",
          // Violates pad_left on top (gap = 0.0 - 0.1 = -0.1... center y=0.2, half=0.2 -> bottom=0, wire y=-0.08 r=0.1 -> gap=0.02 < 0.15)
          route: [wire(-4, -0.18, 0.2, "top"), wire(-2, -0.18, 0.2, "top")],
        },
      ],
    });

    const baseline = computeSrjBoardDrcSignature(board);
    expect(baseline.violations).toHaveLength(1);
    expect(baseline.violations[0]!.id).toBe(
      "copper_clearance|top|obstacle:pad_left|trace:t_swap",
    );

    // Swap 1: fix pad_left, create identical-gap violation on pad_right -> total count stays 1 === 1!
    const padSwapped: SimplifiedPcbTrace[] = [
      {
        type: "pcb_trace",
        pcb_trace_id: "t_swap",
        connection_name: "VCC",
        route: [wire(2, -1.82, 0.2, "top"), wire(4, -1.82, 0.2, "top")],
      },
    ];
    const padSwappedSig = computeSrjBoardDrcSignature(board, padSwapped);
    expect(padSwappedSig.violations).toHaveLength(1);
    const padSwapCmp = compareSrjBoardDrcSignatures(baseline, padSwappedSig);
    expect(padSwapCmp.safe).toBe(false);
    expect(padSwapCmp.newViolations).toHaveLength(1);
    expect(padSwapCmp.resolvedViolationIds).toHaveLength(1);

    // Swap 2: opposite board-edge swap (minY -> maxY) with identical count 1 === 1
    const edgeBaseTraces: SimplifiedPcbTrace[] = [
      {
        type: "pcb_trace",
        pcb_trace_id: "t_swap",
        connection_name: "VCC",
        route: [wire(-1, -4.85, 0.2, "top"), wire(1, -4.85, 0.2, "top")],
      },
    ];
    const edgeCandTraces: SimplifiedPcbTrace[] = [
      {
        type: "pcb_trace",
        pcb_trace_id: "t_swap",
        connection_name: "VCC",
        route: [wire(-1, 4.85, 0.2, "top"), wire(1, 4.85, 0.2, "top")],
      },
    ];
    const edgeBaseSig = computeSrjBoardDrcSignature(board, edgeBaseTraces);
    const edgeCandSig = computeSrjBoardDrcSignature(board, edgeCandTraces);
    expect(edgeBaseSig.violations).toHaveLength(1);
    expect(edgeCandSig.violations).toHaveLength(1);
    expect(compareSrjBoardDrcSignatures(edgeBaseSig, edgeCandSig).safe).toBe(
      false,
    );
  });

  test("rolls back equal-count violation swaps in expansion, cleanup, and clearance-repair while separating attempted* vs committed stats", () => {
    const swapBoard = makeBaseBoard({
      obstacles: [
        {
          type: "rect",
          obstacleId: "pad_a",
          center: { x: -4, y: 2.28 },
          width: 0.4,
          height: 0.4, // bottom at 2.08
          layers: ["top"],
          connectedTo: ["NET_A", "pcb_smtpad_a"],
        },
        {
          type: "rect",
          obstacleId: "pad_b",
          center: { x: 4, y: -2.28 },
          width: 0.4,
          height: 0.4, // top at -2.08
          layers: ["top"],
          connectedTo: ["NET_B", "pcb_smtpad_b"],
        },
      ],
      traces: [
        {
          type: "pcb_trace",
          pcb_trace_id: "trace_vcc",
          connection_name: "VCC",
          route: [wire(-6, 0, 0.2, "top"), wire(6, 0, 0.2, "top")],
        },
        {
          type: "pcb_trace",
          pcb_trace_id: "trace_sig",
          connection_name: "SIG",
          // Baseline violation against pad_a (gap = 2.08 - 2.05 = 0.03 < 0.15)
          route: [wire(-5, 1.95, 0.2, "top"), wire(-3, 1.95, 0.2, "top")],
        },
      ],
    });

    // Case A: Expansion phase equal-count violation swap -> rolls back to initial traces & 0 committed expansions
    const expSolver = new PowerTraceExpanderSolver(structuredClone(swapBoard), {
      onlyConnectionNames: ["VCC"],
    });
    const origFinishPass = (
      expSolver as unknown as { finishOrStartNextPass: () => void }
    ).finishOrStartNextPass.bind(expSolver);
    let injectedExpansionSwap = false;
    (
      expSolver as unknown as { finishOrStartNextPass: () => void }
    ).finishOrStartNextPass = () => {
      if (!injectedExpansionSwap) {
        injectedExpansionSwap = true;
        // VCC was already widened in Pass 1 (expandedSegmentCount > 0);
        // simulate a faulty side-effect that moved trace_sig's violation from pad_a to pad_b (1 === 1 count!)
        expSolver.traces[1]!.route = [
          wire(3, -1.95, 0.2, "top"),
          wire(5, -1.95, 0.2, "top"),
        ];
      }
      origFinishPass();
    };
    expSolver.solve();

    expect(expSolver.drcRollbackPhases).toContain("expansion");
    expect(expSolver.stats.attemptedExpandedSegmentCount).toBeGreaterThan(0);
    expect(expSolver.stats.expandedSegmentCount).toBe(0);
    expect(expSolver.getOutput()).toEqual(swapBoard.traces!);
    expect(expSolver.stats.resultStatus).toBe("best_effort");
    expect(expSolver.stats.completionReason).toBe("drc_rollback");

    // Case B: Cleanup phase equal-count violation swap -> preserves valid expansion, rolls back cleanup & cleanup stats
    const cleanupSolver = new PowerTraceExpanderSolver(
      structuredClone(swapBoard),
      { onlyConnectionNames: ["VCC"] },
    );
    // Run Pass 1 cleanly, then intercept cleanup solver adoption
    const origStartCleanup = (
      cleanupSolver as unknown as { startCleanup: () => void }
    ).startCleanup.bind(cleanupSolver);
    let preCleanupValidated: SimplifiedPcbTrace[] = [];
    (cleanupSolver as unknown as { startCleanup: () => void }).startCleanup =
      () => {
        preCleanupValidated = structuredClone(cleanupSolver.traces);
        origStartCleanup();
        const activeCleanup =
          cleanupSolver.activeSubSolver as PowerTraceCleanupSolver;
        activeCleanup.getOutput = () => {
          const swapped = structuredClone(preCleanupValidated);
          swapped[1]!.route = [
            wire(3, -1.95, 0.2, "top"),
            wire(5, -1.95, 0.2, "top"),
          ];
          return swapped;
        };
        Object.defineProperty(activeCleanup, "stats", {
          get: () => ({
            viaPairCountRemoved: 2,
            viaCountRemoved: 4,
            simplifiedPathCount: 3,
          }),
          set: () => {},
          configurable: true,
        });
      };
    cleanupSolver.solve();

    expect(cleanupSolver.drcRollbackPhases).toContain("cleanup");
    expect(cleanupSolver.stats.cleanupStatus).toBe("drc_rollback");
    expect(cleanupSolver.stats.attemptedRemovedViaPairCount).toBe(2);
    expect(cleanupSolver.stats.attemptedSimplifiedPathCount).toBe(3);
    expect(cleanupSolver.stats.removedViaPairCount).toBe(0);
    expect(cleanupSolver.stats.simplifiedPathCount).toBe(0);
    expect(cleanupSolver.stats.expandedSegmentCount).toBeGreaterThan(0);
    expect(cleanupSolver.getOutput()).toEqual(preCleanupValidated);

    // Case C: Clearance-repair phase equal-count violation swap -> rolls back clearance repair & repair stats
    const repairSolver = new PowerTraceExpanderSolver(
      structuredClone(swapBoard),
      { onlyConnectionNames: ["VCC"] },
    );
    const origStartRepair = (
      repairSolver as unknown as { startTraceClearanceRepair: () => void }
    ).startTraceClearanceRepair.bind(repairSolver);
    let preRepairValidated: SimplifiedPcbTrace[] = [];
    (
      repairSolver as unknown as { startTraceClearanceRepair: () => void }
    ).startTraceClearanceRepair = () => {
      preRepairValidated = structuredClone(repairSolver.traces);
      origStartRepair();
      const activeRepair =
        repairSolver.activeSubSolver as PowerTraceClearanceRepairSolver;
      activeRepair.getOutput = () => {
        const swapped = structuredClone(preRepairValidated);
        swapped[1]!.route = [
          wire(3, -1.95, 0.2, "top"),
          wire(5, -1.95, 0.2, "top"),
        ];
        return swapped;
      };
      Object.defineProperty(activeRepair, "stats", {
        get: () => ({
          repairedSegmentCount: 5,
          repairedPadNeckSegmentCount: 1,
        }),
        set: () => {},
        configurable: true,
      });
    };
    repairSolver.solve();

    expect(repairSolver.drcRollbackPhases).toContain("clearance-repair");
    expect(repairSolver.stats.clearanceRepairStatus).toBe("drc_rollback");
    expect(repairSolver.stats.attemptedRepairedTraceClearanceSegmentCount).toBe(
      5,
    );
    expect(repairSolver.stats.attemptedRepairedPadNeckSegmentCount).toBe(1);
    expect(repairSolver.stats.repairedTraceClearanceSegmentCount).toBe(0);
    expect(repairSolver.stats.repairedPadNeckSegmentCount).toBe(0);
    expect(repairSolver.getOutput()).toEqual(preRepairValidated);
  });
});

describe("SrjBoardDrcCertificate — forced budget exhaustion in every phase", () => {
  test("certifies and rolls back cleanly under forced budget exhaustion in expansion, cleanup, clearance-repair, and final acceptance", () => {
    const baseInput = structuredClone(simplifiedCases.narrowChannelRetreat);
    const initialSig = computeSrjBoardDrcSignature(baseInput);

    // 1. Mid-expansion tryFinalAcceptance with an injected DRC regression rolls back to lastValidatedTraces
    const midExpSolver = new PowerTraceExpanderSolver(
      structuredClone(baseInput),
    );
    while (
      (!midExpSolver.activeSubSolver ||
        midExpSolver.activeSubSolver.iterations === 0) &&
      !midExpSolver.solved
    ) {
      midExpSolver.step();
    }
    // Corrupt in-memory trace before tryFinalAcceptance
    midExpSolver.traces[0]!.route.push(wire(0, 9.98, 0.4, "top"));
    midExpSolver.tryFinalAcceptance();
    expect(midExpSolver.solved).toBe(true);
    expect(midExpSolver.drcRollbackPhases).toContain("final");
    expect(
      compareSrjBoardDrcSignatures(
        initialSig,
        computeSrjBoardDrcSignature(baseInput, midExpSolver.getOutput()),
      ).safe,
    ).toBe(true);

    // 2. Expansion budget exhaustion -> budget-finalization rollback when partial expansion regressed
    const budgetExpSolver = new PowerTraceExpanderSolver(
      structuredClone(baseInput),
    );
    budgetExpSolver.MAX_ITERATIONS = 10_000;
    budgetExpSolver.step();
    budgetExpSolver.traces[0]!.route.push(wire(0, 9.98, 0.4, "top"));
    budgetExpSolver.iterations =
      Number(budgetExpSolver.stats.expansionIterationBudget) - 1;
    budgetExpSolver.step();
    expect(budgetExpSolver.phase).toBe("cleanup");
    expect(budgetExpSolver.drcRollbackPhases).toContain("budget-finalization");
    budgetExpSolver.solve();
    expect(
      compareSrjBoardDrcSignatures(
        initialSig,
        computeSrjBoardDrcSignature(baseInput, budgetExpSolver.getOutput()),
      ).safe,
    ).toBe(true);

    // 3. Cleanup budget exhaustion + mid-cleanup tryFinalAcceptance
    const cleanupBudgetSolver = new PowerTraceExpanderSolver(
      structuredClone(baseInput),
    );
    cleanupBudgetSolver.MAX_ITERATIONS = 16;
    while (
      cleanupBudgetSolver.phase !== "cleanup" &&
      !cleanupBudgetSolver.solved
    ) {
      cleanupBudgetSolver.step();
    }
    expect(cleanupBudgetSolver.phase).toBe("cleanup");
    const activeCleanup =
      cleanupBudgetSolver.activeSubSolver as PowerTraceCleanupSolver;
    activeCleanup.MAX_ITERATIONS = 1;
    cleanupBudgetSolver.solve();
    expect(cleanupBudgetSolver.solved).toBe(true);
    expect(
      compareSrjBoardDrcSignatures(
        initialSig,
        computeSrjBoardDrcSignature(baseInput, cleanupBudgetSolver.getOutput()),
      ).safe,
    ).toBe(true);

    // 4. Clearance-repair budget exhaustion + mid-clearance-repair tryFinalAcceptance (both clean & regressed)
    const repairBudgetSolver = new PowerTraceExpanderSolver(
      structuredClone(baseInput),
    );
    const activeRepairChild = new PowerTraceClearanceRepairSolver({
      simpleRouteJson: repairBudgetSolver.inputProblem,
      traces: structuredClone(repairBudgetSolver.traces),
      traceIndices: [0],
    });
    activeRepairChild.MAX_ITERATIONS = 1;
    repairBudgetSolver.phase = "repair-trace-clearance";
    repairBudgetSolver.activeSubSolver = activeRepairChild;
    repairBudgetSolver.tryFinalAcceptance();
    expect(repairBudgetSolver.solved).toBe(true);
    expect(repairBudgetSolver.finalAcceptanceUsed).toBe(true);
    expect(
      compareSrjBoardDrcSignatures(
        initialSig,
        computeSrjBoardDrcSignature(baseInput, repairBudgetSolver.getOutput()),
      ).safe,
    ).toBe(true);

    // Regressed clearance-repair during tryFinalAcceptance rolls back cleanly
    const regressedRepairSolver = new PowerTraceExpanderSolver(
      structuredClone(baseInput),
    );
    const badRepairChild = new PowerTraceClearanceRepairSolver({
      simpleRouteJson: regressedRepairSolver.inputProblem,
      traces: structuredClone(regressedRepairSolver.traces),
      traceIndices: [0],
    });
    badRepairChild.getOutput = () => {
      const bad = structuredClone(regressedRepairSolver.traces);
      bad[0]!.route.push(wire(0, 9.98, 0.4, "top"));
      return bad;
    };
    regressedRepairSolver.phase = "repair-trace-clearance";
    regressedRepairSolver.activeSubSolver = badRepairChild;
    regressedRepairSolver.tryFinalAcceptance();
    expect(regressedRepairSolver.solved).toBe(true);
    expect(regressedRepairSolver.drcRollbackPhases).toContain(
      "clearance-repair",
    );
    expect(regressedRepairSolver.stats.clearanceRepairStatus).toBe(
      "drc_rollback",
    );
    expect(
      compareSrjBoardDrcSignatures(
        initialSig,
        computeSrjBoardDrcSignature(
          baseInput,
          regressedRepairSolver.getOutput(),
        ),
      ).safe,
    ).toBe(true);
  });
});

describe("SrjBoardDrcCertificate — seeded property / fuzz monotonicity", () => {
  test("40 seeded random valid & pre-violating multi-layer boards satisfy strict no-new-DRC monotonicity", () => {
    const rng = createMulberry32(0x23_2026_01);
    const layersByCount = {
      2: ["top", "bottom"],
      4: ["top", "inner1", "inner2", "bottom"],
    } as const;

    for (let seedIndex = 0; seedIndex < 40; seedIndex++) {
      const layerCount = rng() < 0.5 ? 2 : 4;
      const layers = layersByCount[layerCount];
      const obstacleCount = 4 + Math.floor(rng() * 8);
      const obstacles: Obstacle[] = [];

      for (let i = 0; i < obstacleCount; i++) {
        const netName =
          i % 4 === 0 ? "VCC" : i % 4 === 1 ? "GND" : `SIG_${i % 3}`;
        const layerChoice =
          rng() < 0.3
            ? [...layers]
            : [layers[Math.floor(rng() * layers.length)]!];
        const kindRoll = rng();
        const cx = -6 + rng() * 12;
        const cy = -5 + rng() * 10;
        const size = 0.4 + rng() * 0.9;

        if (kindRoll < 0.25) {
          obstacles.push({
            type: "rect",
            shape: "circle",
            obstacleId: `fuzz_obs_${seedIndex}_${i}`,
            center: { x: cx, y: cy },
            width: size,
            height: size,
            layers: layerChoice,
            connectedTo: rng() < 0.3 ? [] : [netName, `pcb_plated_hole_${i}`],
            isNonPlatedHole: rng() < 0.3,
          });
        } else if (kindRoll < 0.5) {
          obstacles.push({
            type: "oval" as unknown as "rect",
            obstacleId: `fuzz_obs_${seedIndex}_${i}`,
            center: { x: cx, y: cy },
            width: size,
            height: size,
            layers: layerChoice,
            connectedTo: [netName, `pcb_smtpad_${i}`],
          });
        } else {
          obstacles.push({
            type: "rect",
            obstacleId: `fuzz_obs_${seedIndex}_${i}`,
            center: { x: cx, y: cy },
            width: size,
            height: 0.4 + rng() * 0.8,
            ccwRotationDegrees: Math.floor(rng() * 6) * 15,
            layers: layerChoice,
            connectedTo: [netName, `pcb_smtpad_${i}`],
            isCopperPour: rng() < 0.2,
          });
        }
      }

      const pwrY = -4 + rng() * 8;
      const pwrLayer = layers[Math.floor(rng() * layers.length)]!;
      const sigY = -4 + rng() * 8;
      const sigLayer = layers[Math.floor(rng() * layers.length)]!;

      const traces: SimplifiedPcbTrace[] = [
        {
          type: "pcb_trace",
          pcb_trace_id: `pwr_${seedIndex}`,
          connection_name: "VCC",
          route: [
            wire(-7.5, pwrY, 0.18, pwrLayer),
            wire(0, pwrY + (rng() - 0.5) * 1.5, 0.18, pwrLayer),
            wire(7.5, pwrY, 0.18, pwrLayer),
          ],
        },
        {
          type: "pcb_trace",
          pcb_trace_id: `sig_${seedIndex}`,
          connection_name: "SIG_0",
          route: [
            wire(-7.0, sigY, 0.16, sigLayer),
            via(-1 + rng() * 2, sigY, sigLayer, layers[0]!, 0.6, 0.3),
            wire(7.0, sigY, 0.16, layers[0]!),
          ],
        },
      ];

      const fixedTraces: SimplifiedPcbTrace[] =
        rng() < 0.5
          ? [
              {
                type: "pcb_trace",
                pcb_trace_id: `fixed_${seedIndex}`,
                connection_name: "GND",
                route: [
                  wire(-7.5, -6.5 + rng() * 2, 0.2, "top"),
                  wire(7.5, -6.5 + rng() * 2, 0.2, "top"),
                ],
              },
            ]
          : [];

      const board: SimpleRouteJson = {
        layerCount,
        minTraceWidth: 0.15,
        nominalTraceWidth: 0.65,
        defaultObstacleMargin: 0.15,
        minTraceToPadEdgeClearance: 0.15,
        minPadEdgeToPadEdgeClearance: 0.12,
        minTraceToHoleEdgeClearance: 0.2,
        minBoardEdgeClearance: 0.2,
        minViaHoleEdgeToViaHoleEdgeClearance: 0.2,
        minViaPadDiameter: 0.6,
        minViaHoleDiameter: 0.3,
        bounds: { minX: -9, maxX: 9, minY: -9, maxY: 9 },
        connections: [
          {
            name: "VCC",
            nominalTraceWidth: 0.65,
            pointsToConnect: [
              { x: -7.5, y: pwrY, layer: pwrLayer },
              { x: 7.5, y: pwrY, layer: pwrLayer },
            ],
          },
          {
            name: "SIG_0",
            nominalTraceWidth: 0.2,
            pointsToConnect: [
              { x: -7.0, y: sigY, layer: sigLayer },
              { x: 7.0, y: sigY, layer: layers[0]! },
            ],
          },
        ],
        obstacles,
        fixedTraces,
        traces,
      };

      const certificate = new SrjBoardDrcCertificate(board, board.traces);
      // Reflexivity law
      expect(certificate.validate(board.traces!).safe).toBe(true);

      const solver = new PowerTraceExpanderSolver(board, {
        allowNewVias: rng() < 0.7,
      });
      solver.MAX_ITERATIONS =
        seedIndex % 5 === 0 ? 8 + Math.floor(rng() * 12) : 48;
      if (seedIndex % 7 === 0) {
        const cutoffSteps = 1 + Math.floor(rng() * 6);
        for (let s = 0; s < cutoffSteps && !solver.solved; s++) {
          solver.step();
        }
        if (!solver.solved) solver.tryFinalAcceptance();
      } else {
        solver.solve();
      }

      const output = solver.getOutput();
      const finalSig = computeSrjBoardDrcSignature(board, output);
      const comparison = compareSrjBoardDrcSignatures(
        certificate.initialSignature,
        finalSig,
      );

      expect(solver.solved).toBe(true);
      expect(solver.failed).toBe(false);
      expect(comparison.safe).toBe(true);
      expect(comparison.newViolations).toHaveLength(0);
      expect(comparison.worsenedViolations).toHaveLength(0);

      // Direct candidate perturbation check: any new violation or worsened gap is strictly caught
      const perturbed = structuredClone(output);
      perturbed.push({
        type: "pcb_trace",
        pcb_trace_id: `rogue_edge_${seedIndex}`,
        connection_name: "ROGUE_NET",
        route: [wire(-8.95, -8.95, 0.2, "top"), wire(-7.0, -8.95, 0.2, "top")],
      });
      const perturbedSig = computeSrjBoardDrcSignature(board, perturbed);
      expect(
        compareSrjBoardDrcSignatures(certificate.initialSignature, perturbedSig)
          .safe,
      ).toBe(false);
    }
  }, 30_000);
});

describe("SrjBoardDrcCertificate — RP2040 & MangoPi fixtures", () => {
  test("RP2040 dual-motor fixture satisfies whole-board no-new-DRC certificate", () => {
    const fullBaseline = computeSrjBoardDrcSignature(
      rp2040Input as unknown as SimpleRouteJson,
    );
    expect(fullBaseline.hasUnsupportedGeometry).toBe(false);
    expect(compareSrjBoardDrcSignatures(fullBaseline, fullBaseline).safe).toBe(
      true,
    );

    const sliceProblem = createUpperPMotorAProblem();
    const sliceBaseline = computeSrjBoardDrcSignature(sliceProblem);
    const solver = new PowerTraceExpanderSolver(sliceProblem, {
      onlyConnectionNames: [UPPER_P_MOTOR_A_CONNECTION],
    });
    solver.solve();

    const sliceFinal = computeSrjBoardDrcSignature(
      sliceProblem,
      solver.getOutput(),
    );
    const comparison = compareSrjBoardDrcSignatures(sliceBaseline, sliceFinal);

    expect(solver.solved).toBe(true);
    expect(comparison.safe).toBe(true);
    expect(solver.stats.drcCertificateStatus).toBe("certified");
    expect(solver.stats.drcRollbackCount).toBe(0);
  }, 60_000);

  test("MangoPi 6-layer power-expansion profile (plus full capture when present) satisfies no-new-DRC certificate", async () => {
    // Representative 6-layer MangoPi R3C profile: allowNewVias: false, onlyConnectionNames,
    // circular oval pads, shared coincident MST vias, and pre-existing signal DRC debt.
    const mangopiProfile: SimpleRouteJson = {
      layerCount: 6,
      minTraceWidth: 0.1,
      nominalTraceWidth: 0.5,
      defaultObstacleMargin: 0.1,
      minTraceToPadEdgeClearance: 0.1,
      minPadEdgeToPadEdgeClearance: 0.1,
      minTraceToHoleEdgeClearance: 0.15,
      minBoardEdgeClearance: 0.2,
      minViaHoleEdgeToViaHoleEdgeClearance: 0.15,
      min_via_pad_diameter: 0.45,
      min_via_hole_diameter: 0.25,
      bounds: { minX: -15, maxX: 15, minY: -12, maxY: 12 },
      connections: [
        {
          name: "VDD_5V",
          nominalTraceWidth: 0.6,
          pointsToConnect: [
            { x: -10, y: 0, layer: "top" },
            { x: 10, y: 0, layer: "inner2" },
          ],
        },
        {
          name: "DRAM_DQ0",
          nominalTraceWidth: 0.12,
          pointsToConnect: [
            { x: -8, y: 4, layer: "inner3" },
            { x: 8, y: 4, layer: "inner3" },
          ],
        },
      ],
      obstacles: [
        {
          type: "oval" as unknown as "rect",
          obstacleId: "usb_vbus_pin",
          center: { x: -10, y: 0 },
          width: 0.9,
          height: 0.9,
          layers: ["top", "inner1", "inner2", "inner3", "inner4", "bottom"],
          connectedTo: ["VDD_5V", "pcb_plated_hole_vbus"],
        },
        {
          type: "rect",
          obstacleId: "pmic_vin_pad",
          center: { x: 10, y: 0 },
          width: 0.8,
          height: 0.8,
          ccwRotationDegrees: 90,
          layers: ["top"],
          connectedTo: ["VDD_5V", "pcb_smtpad_pmic"],
        },
        // Tight neighboring BGA pad creating pre-existing debt on DRAM_DQ0
        {
          type: "oval" as unknown as "rect",
          obstacleId: "bga_gnd_ball",
          center: { x: 0, y: 4.24 },
          width: 0.35,
          height: 0.35,
          layers: ["top", "inner3"],
          connectedTo: ["GND", "pcb_smtpad_bga_gnd"],
        },
      ],
      fixedTraces: [
        {
          type: "pcb_trace",
          pcb_trace_id: "fixed_gnd_spine",
          connection_name: "GND",
          route: [wire(-10, -2.0, 0.3, "top"), wire(10, -2.0, 0.3, "top")],
        },
      ],
      traces: [
        // Two MST subtraces sharing one coincident through-via at (0, 0)
        {
          type: "pcb_trace",
          pcb_trace_id: "vdd_5v_seg_a",
          connection_name: "VDD_5V",
          route: [
            wire(-10, 0, 0.15, "top"),
            wire(0, 0, 0.15, "top"),
            via(0, 0, "top", "inner2", 0.45, 0.25),
            wire(0, 0, 0.15, "inner2"),
            wire(10, 0, 0.15, "inner2"),
            via(10, 0, "inner2", "top", 0.45, 0.25),
            wire(10, 0, 0.15, "top"),
          ],
        },
        {
          type: "pcb_trace",
          pcb_trace_id: "vdd_5v_seg_b",
          connection_name: "VDD_5V",
          route: [
            wire(0, 0, 0.15, "top"),
            via(0, 0, "top", "inner2", 0.45, 0.25),
            wire(0, 3.0, 0.15, "inner2"),
          ],
        },
        // Pre-existing signal trace with tight BGA clearance debt (gap = 4.24 - 0.175 - 4.0 - 0.06 = 0.005 < 0.10)
        {
          type: "pcb_trace",
          pcb_trace_id: "dram_dq0",
          connection_name: "DRAM_DQ0",
          route: [wire(-8, 4, 0.12, "inner3"), wire(8, 4, 0.12, "inner3")],
        },
      ],
    };

    const initialSig = computeSrjBoardDrcSignature(mangopiProfile);
    expect(initialSig.hasUnsupportedGeometry).toBe(false);
    expect(initialSig.violationCountByKind.same_net_via_spacing).toBe(0);
    expect(initialSig.violationCountByKind.copper_clearance).toBe(1);

    const solver = new PowerTraceExpanderSolver(mangopiProfile, {
      allowNewVias: false,
      onlyConnectionNames: ["VDD_5V"],
    });
    solver.solve();

    const output = solver.getOutput();
    const finalSig = computeSrjBoardDrcSignature(mangopiProfile, output);
    const cmp = compareSrjBoardDrcSignatures(initialSig, finalSig);

    expect(solver.solved).toBe(true);
    expect(cmp.safe).toBe(true);
    expect(solver.stats.drcCertificateStatus).toBe("certified");
    expect(solver.stats.drcRollbackCount).toBe(0);
    expect(solver.expandedSegmentCount).toBeGreaterThan(0);

    // Automatically validate full MangoPi R3C capture if present alongside PR #22
    const fullCaptureFile = Bun.file(
      new URL(
        "../fixtures/mangopi-r3c-power-disconnection/powerTraceExpansionSolver_input.json",
        import.meta.url,
      ),
    );
    if (await fullCaptureFile.exists()) {
      const [fullSrj, fullOpts] = JSON.parse(await fullCaptureFile.text());
      const fullBase = computeSrjBoardDrcSignature(fullSrj);
      const fullSolver = new PowerTraceExpanderSolver(fullSrj, fullOpts);
      fullSolver.solve();
      const fullCand = computeSrjBoardDrcSignature(
        fullSrj,
        fullSolver.getOutput(),
      );
      expect(compareSrjBoardDrcSignatures(fullBase, fullCand).safe).toBe(true);
    }
  }, 60_000);
});
