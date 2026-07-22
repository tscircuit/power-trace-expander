import type { SimpleRouteJson } from "@tscircuit/core";
import { GenericSolverDebugger } from "@tscircuit/solver-utils/react";
import { useMemo } from "react";
import { PowerTraceCleanupSolver } from "../src";

export const PowerTraceCleanupDebugger = ({
  problem,
  animationSpeed = 30,
}: {
  problem: SimpleRouteJson;
  animationSpeed?: number;
}) => {
  const solver = useMemo(
    () =>
      new PowerTraceCleanupSolver({
        simpleRouteJson: problem,
        traces: problem.traces ?? [],
      }),
    [problem],
  );

  return (
    <GenericSolverDebugger solver={solver} animationSpeed={animationSpeed} />
  );
};
