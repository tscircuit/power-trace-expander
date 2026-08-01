import { expect, setDefaultTimeout, test } from "bun:test";
import "graphics-debug/matcher";
import {
  getSample001ViaPairReproduction,
  getSample001ViaPairGraphics,
  SAMPLE001_TARGET_TRACE_ID,
  SAMPLE001_UNNECESSARY_VIA_PAIR,
} from "../fixtures/sample001-via-pair/getSample001ViaPairReproduction";

setDefaultTimeout(60_000);

const getViaCoordinates = (
  trace: ReturnType<typeof getSample001ViaPairReproduction>["targetTrace"],
) =>
  trace.route.flatMap((point) =>
    point.route_type === "via"
      ? [
          {
            x: point.x,
            y: point.y,
            from_layer: point.from_layer,
            to_layer: point.to_layer,
          },
        ]
      : [],
  );

test("reproduces the sample001 via pair created before cleanup", async () => {
  const { graphics, problem, solver, targetTrace } =
    getSample001ViaPairReproduction();

  expect(solver.phase).toBe("cleanup");
  expect(getViaCoordinates(targetTrace)).toEqual(
    SAMPLE001_UNNECESSARY_VIA_PAIR,
  );
  expect(
    problem.obstacles.find((obstacle) =>
      obstacle.connectedTo.includes("pcb_smtpad_37"),
    ),
  ).toMatchObject({
    center: { x: -7.53003695, y: -9.689973 },
    width: 1.5999968,
    height: 3.1999936,
    layers: ["top"],
  });
  await expect(graphics).toMatchGraphicsSvg(import.meta.path, {
    svgName: "sample001-via-pair-before-cleanup",
  });

  solver.solve();
  const outputTargetTrace = solver
    .getOutput()
    .find((trace) => trace.pcb_trace_id === SAMPLE001_TARGET_TRACE_ID)!;
  expect(getViaCoordinates(outputTargetTrace)).toEqual([]);
  await expect(
    getSample001ViaPairGraphics({
      problem,
      targetTrace: outputTargetTrace,
      title: "sample001 after cleanup: via pair removed",
    }),
  ).toMatchGraphicsSvg(import.meta.path, {
    svgName: "sample001-via-pair-after-cleanup",
  });
});
