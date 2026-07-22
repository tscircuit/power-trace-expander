import type { SimpleRouteJson } from "@tscircuit/core";
import { GenericSolverDebugger } from "@tscircuit/solver-utils/react";
import { useMemo } from "react";
import {
  PowerTraceExpanderSolver,
  type PowerTraceExpanderOptions,
} from "../src";

export const PowerTraceExpanderDebugger = ({
  problem,
  solverOptions,
  animationSpeed = 30,
}: {
  problem: SimpleRouteJson;
  solverOptions?: PowerTraceExpanderOptions;
  animationSpeed?: number;
}) => {
  const solver = useMemo(
    () => new PowerTraceExpanderSolver(structuredClone(problem), solverOptions),
    [problem, solverOptions],
  );

  return (
    <GenericSolverDebugger solver={solver} animationSpeed={animationSpeed} />
  );
};
