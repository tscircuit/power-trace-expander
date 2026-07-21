import { GenericSolverDebugger } from "@tscircuit/solver-utils/react";
import { useMemo } from "react";
import { PowerTraceExpanderSolver } from "../src";
import { centralObstacleFixture } from "./central-obstacle";

export default function PowerTraceExpanderDebuggerFixture() {
  const solver = useMemo(
    () => new PowerTraceExpanderSolver(structuredClone(centralObstacleFixture)),
    [],
  );

  return <GenericSolverDebugger solver={solver} animationSpeed={30} />;
}
