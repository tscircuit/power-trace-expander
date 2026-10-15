import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import "bun-match-svg";
import type { SimpleRouteJson } from "@tscircuit/core";
import { getSvgFromGraphicsObject } from "graphics-debug";
import { getPowerTraceGraphics } from "../fixtures/getPowerTraceGraphics";
import { PowerTraceExpanderSolver } from "../src";

test("receiver full-board power expansion terminal neck", async () => {
  // Exact powerTraceExpansionSolver input from receiver report 40b373.
  const input: SimpleRouteJson = JSON.parse(
    readFileSync(
      new URL(
        "../fixtures/receiver-terminal-neck/receiver-power-expansion-input.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  expect(input.connections).toHaveLength(44);
  expect(input.obstacles).toHaveLength(202);
  expect(input.traces).toHaveLength(144);
  const solver = new PowerTraceExpanderSolver(input, {
    allowNewVias: false,
    onlyConnectionNames: [
      "source_net_0",
      "source_net_1",
      "source_net_2",
      "source_net_4",
    ],
  });
  solver.solve();
  expect(solver.solved).toBe(true);
  expect(solver.failed).toBe(false);
  const escape = solver
    .getOutput()
    .find(
      (trace) =>
        trace.connectsTo?.includes("pcb_port_132") &&
        trace.connectsTo?.includes("pcb_port_82"),
    );
  expect(escape).toBeDefined();
  const wires = escape!.route
    .filter((point) => point.route_type === "wire")
    .filter((point) => point.layer === "top");
  expect(wires[0]!.width).toBeCloseTo(0.7500112, 6);
  expect(wires[1]!.y - wires[0]!.y).toBeCloseTo(0.3750056, 5);
  expect(wires[2]!.width).toBe(1);
  expect(wires[3]!.width).toBe(1);

  const graphics = getPowerTraceGraphics({
    problem: input,
    traces: solver.getOutput(),
  });
  graphics.points = [];
  const boardSvg = getSvgFromGraphicsObject(graphics, {
    backgroundColor: "white",
  });
  const detailSvg = boardSvg.replace(
    'width="640" height="640" viewBox="0 0 640 640"',
    'x="660" y="150" width="320" height="500" viewBox="130 365 70 110"',
  );
  const header = `<text x="24" y="32" font-family="Arial" font-size="20">Receiver PCB: power-trace terminal neck</text><text x="24" y="60" font-family="Arial" font-size="16">Requested 1 mm | pad escape ${wires[0]!.width.toFixed(3)} mm</text><text x="24" y="84" font-family="Arial" font-size="13">Full captured board: 44 connections, 202 obstacles, 144 routed traces.</text>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="760" viewBox="0 0 1000 760"><rect width="100%" height="100%" fill="white"/>${header}${boardSvg.replace("<svg ", '<svg y="100" ')}<rect x="130" y="465" width="70" height="110" fill="none" stroke="#2563eb" stroke-dasharray="4 3"/><text x="660" y="130" font-family="Arial" font-size="18">Pad escape detail</text>${detailSvg}</svg>`;
  await expect(svg).toMatchSvgSnapshot(import.meta.path);
});
