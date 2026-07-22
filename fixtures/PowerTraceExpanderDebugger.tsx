import type { SimpleRouteJson } from "@tscircuit/core";
import { GenericSolverDebugger } from "@tscircuit/solver-utils/react";
import { useMemo } from "react";
import { PowerTraceExpanderSolver } from "../src";

export const PowerTraceExpanderDebugger = ({
  problem,
  animationSpeed = 30,
}: {
  problem: SimpleRouteJson;
  animationSpeed?: number;
}) => {
  const solver = useMemo(
    () => new PowerTraceExpanderSolver(structuredClone(problem)),
    [problem],
  );

  return (
    <GenericSolverDebugger solver={solver} animationSpeed={animationSpeed} />
  );
};
