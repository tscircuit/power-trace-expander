import { expect, test } from "bun:test";
import "bun-match-svg";
import {
  type GraphicsObject,
  getSvgFromGraphicsObject,
  stackGraphicsHorizontally,
} from "graphics-debug";
import {
  createFragmentedConnectedPadNeckdownProblem,
  FRAGMENTED_PAD_ID,
  FRAGMENTED_PAD_MINIMUM_TRACE_WIDTH,
} from "../fixtures/fragmented-connected-pad-neckdown/createFragmentedConnectedPadNeckdownProblem";
import { PowerTraceExpanderSolver } from "../src";
import type { SimpleRouteJson, SimplifiedPcbTrace } from "../src/types";

const getMinimumWireWidth = (trace: SimplifiedPcbTrace) =>
  Math.min(
    ...trace.route.flatMap((point) =>
      point.route_type === "wire" ? [point.width] : [],
    ),
  );

const getWireSegments = (trace: SimplifiedPcbTrace) =>
  trace.route.slice(1).flatMap((end, routeIndex) => {
    const start = trace.route[routeIndex];
    if (start?.route_type !== "wire" || end.route_type !== "wire") return [];
    return [
      {
        start,
        end,
        width: start.width,
        length: Math.hypot(end.x - start.x, end.y - start.y),
      },
    ];
  });

const drawFragmentedPadTrace = ({
  problem,
  trace,
  measuredOutputWidth,
}: {
  problem: SimpleRouteJson;
  trace: SimplifiedPcbTrace;
  measuredOutputWidth?: number;
}): GraphicsObject => {
  const terminalViewMaximumX = 0.3;
  const terminalTraceStart = trace.route[0];
  const terminalTraceEnd = trace.route[1];
  const terminalTraceRects =
    terminalTraceStart?.route_type === "wire" &&
    terminalTraceEnd?.route_type === "wire"
      ? [
          {
            center: {
              x:
                (terminalTraceStart.x +
                  Math.min(terminalTraceEnd.x, terminalViewMaximumX)) /
                2,
              y: terminalTraceStart.y,
            },
            width:
              Math.min(terminalTraceEnd.x, terminalViewMaximumX) -
              terminalTraceStart.x,
            height: terminalTraceStart.width,
            fill:
              terminalTraceStart.width < problem.minTraceWidth
                ? "#dc2626"
                : measuredOutputWidth
                  ? "#16a34a"
                  : "#2563eb",
            stroke:
              terminalTraceStart.width < problem.minTraceWidth
                ? "#991b1b"
                : measuredOutputWidth
                  ? "#166534"
                  : "#1d4ed8",
          },
        ]
      : [];
  const fragmentedPadObstacles = problem.obstacles.filter((obstacle) =>
    obstacle.connectedTo.includes(FRAGMENTED_PAD_ID),
  );

  return {
    coordinateSystem: "cartesian",
    rects: [
      {
        center: { x: 0, y: 0 },
        width: 0.9,
        height: 1,
        fill: "transparent",
        stroke: "#cbd5e1",
      },
      ...fragmentedPadObstacles.map((obstacle, fragmentIndex) => ({
        center: obstacle.center,
        width: obstacle.width,
        height: obstacle.height,
        fill:
          fragmentIndex === 1
            ? "rgba(203, 213, 225, 0.85)"
            : "rgba(226, 232, 240, 0.85)",
        stroke: "#64748b",
      })),
      {
        center: { x: 0, y: 0 },
        width: 0.6,
        height: 0.3,
        fill: "transparent",
        stroke: "#334155",
      },
      ...terminalTraceRects,
    ],
    lines: [
      {
        points: [
          { x: -0.3, y: -0.05 },
          { x: 0.3, y: -0.05 },
        ],
        strokeWidth: 0.008,
        strokeColor: "#64748b",
      },
      {
        points: [
          { x: -0.3, y: 0.05 },
          { x: 0.3, y: 0.05 },
        ],
        strokeWidth: 0.008,
        strokeColor: "#64748b",
      },
    ],
    circles: [
      {
        center: { x: 0, y: 0.01 },
        radius: 0.012,
        fill: "#0f172a",
        stroke: "#0f172a",
      },
    ],
    texts: [
      {
        x: 0,
        y: 0.42,
        text: measuredOutputWidth
          ? "FIXED OUTPUT USES THE COMPLETE PAD"
          : "EXPECTED TERMINAL SEGMENT",
        fontSize: 0.065,
        color: "#0f172a",
      },
      {
        x: 0,
        y: 0.31,
        text: "ALL 3 ROWS = ONE PHYSICAL PAD",
        fontSize: 0.05,
        color: "#334155",
      },
      {
        x: 0,
        y: 0.19,
        text: "TERMINAL",
        fontSize: 0.035,
        color: "#0f172a",
      },
      ...fragmentedPadObstacles.map((obstacle, fragmentIndex) => ({
        x: -0.23,
        y: obstacle.center.y,
        text: `fragment ${fragmentIndex + 1}`,
        fontSize: 0.035,
        color: "#334155",
      })),
      {
        x: 0,
        y: -0.34,
        text: measuredOutputWidth
          ? `GREEN OUTPUT: ${measuredOutputWidth.toFixed(4)} mm ≥ ${problem.minTraceWidth.toFixed(4)} mm MINIMUM`
          : `BLUE INPUT: ${problem.minTraceWidth.toFixed(4)} mm FITS`,
        fontSize: 0.055,
        color: measuredOutputWidth ? "#166534" : "#1d4ed8",
      },
    ],
  };
};

test("preserves the minimum terminal width on a fragmented connected pad", async () => {
  const fragmentedPadInput = createFragmentedConnectedPadNeckdownProblem();
  const inputTrace = fragmentedPadInput.traces?.[0];
  const terminal = fragmentedPadInput.connections[0]?.pointsToConnect[0];
  if (!inputTrace || !terminal) {
    throw new Error("Expected the fixture to contain a trace and terminal");
  }
  const solver = new PowerTraceExpanderSolver(
    structuredClone(fragmentedPadInput),
    { allowNewVias: false },
  );

  solver.solve();

  const outputTrace = solver.getOutput()[0];
  if (!outputTrace) throw new Error("Expected the solver to return a trace");
  const minimumOutputWidth = getMinimumWireWidth(outputTrace);
  const inputSegments = getWireSegments(inputTrace);
  const outputSegments = getWireSegments(outputTrace);
  const belowMinimumSegments = outputSegments.filter(
    (segment) => segment.width < fragmentedPadInput.minTraceWidth,
  );
  const minimumTraceRadius = FRAGMENTED_PAD_MINIMUM_TRACE_WIDTH / 2;
  const fragmentedPadObstacles = fragmentedPadInput.obstacles.filter(
    (obstacle) => obstacle.connectedTo.includes(FRAGMENTED_PAD_ID),
  );

  expect(solver.solved).toBe(true);
  expect(solver.failed).toBe(false);
  expect(solver.stats.repairedPadNeckSegmentCount).toBe(1);
  expect(fragmentedPadObstacles).toHaveLength(3);
  expect(
    fragmentedPadObstacles.every((obstacle) =>
      obstacle.connectedTo.includes(FRAGMENTED_PAD_ID),
    ),
  ).toBe(true);
  expect(Math.abs(terminal.x) + minimumTraceRadius).toBeLessThanOrEqual(0.3);
  expect(Math.abs(terminal.y) + minimumTraceRadius).toBeLessThanOrEqual(0.15);
  expect(
    inputSegments.every(
      (segment) => segment.width >= fragmentedPadInput.minTraceWidth,
    ),
  ).toBe(true);
  expect(minimumOutputWidth).toBeCloseTo(0.28, 6);
  expect(minimumOutputWidth).toBeGreaterThanOrEqual(
    fragmentedPadInput.minTraceWidth,
  );
  expect(belowMinimumSegments).toHaveLength(0);
  expect(
    outputSegments.some(
      (segment) =>
        Math.abs(segment.width - 0.28) < 1e-6 && segment.length > 0.29,
    ),
  ).toBe(true);

  const svg = getSvgFromGraphicsObject(
    stackGraphicsHorizontally([
      drawFragmentedPadTrace({
        problem: fragmentedPadInput,
        trace: inputTrace,
      }),
      drawFragmentedPadTrace({
        problem: fragmentedPadInput,
        trace: outputTrace,
        measuredOutputWidth: minimumOutputWidth,
      }),
    ]),
    { backgroundColor: "white", svgWidth: 1400, svgHeight: 460 },
  );
  await expect(svg).toMatchSvgSnapshot(import.meta.path);
});
