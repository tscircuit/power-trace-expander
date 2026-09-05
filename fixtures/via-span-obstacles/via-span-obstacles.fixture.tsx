import { InteractiveGraphics } from "graphics-debug/react";
import { useMemo, type ReactElement } from "react";
import { PowerTraceExpanderSolver } from "../../src";
import { createViaSpanProblem, type ViaSpanApi } from "./createViaSpanProblem";
import { getViaSpanGraphics } from "./getViaSpanGraphics";

function ViaSpanObstacleFixture({ api }: { api: ViaSpanApi }): ReactElement {
  const graphics = useMemo(() => {
    const input = createViaSpanProblem(api);
    const solver = new PowerTraceExpanderSolver(input, { allowNewVias: false });
    solver.solve();
    return getViaSpanGraphics(input, solver.getOutput(), api);
  }, [api]);
  return <InteractiveGraphics graphics={graphics} />;
}

export default {
  "Endpoint span": <ViaSpanObstacleFixture api="endpoints" />,
  "Explicit layers": <ViaSpanObstacleFixture api="layers" />,
};
