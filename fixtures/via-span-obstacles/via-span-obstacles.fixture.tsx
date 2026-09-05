import { InteractiveGraphics } from "graphics-debug/react";
import { useMemo, type ReactElement } from "react";
import { PowerTraceExpanderSolver } from "../../src";
import { createViaSpanProblem, type ViaSpanCase } from "./createViaSpanProblem";
import { getViaSpanGraphics } from "./getViaSpanGraphics";

function ViaSpanObstacleFixture({
  spanCase,
}: { spanCase: ViaSpanCase }): ReactElement {
  const graphics = useMemo(() => {
    const input = createViaSpanProblem(spanCase);
    const solver = new PowerTraceExpanderSolver(input, { allowNewVias: false });
    solver.solve();
    return getViaSpanGraphics(input, solver.getOutput(), spanCase);
  }, [spanCase]);
  return <InteractiveGraphics graphics={graphics} />;
}

export default {
  "Endpoint span": <ViaSpanObstacleFixture spanCase="endpoints" />,
  "Reversed endpoints": <ViaSpanObstacleFixture spanCase="reversed" />,
};
