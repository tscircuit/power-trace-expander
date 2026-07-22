import { GenericSolverDebugger } from "@tscircuit/solver-utils/react";
import { useMemo } from "react";
import { PowerTraceExpanderSolver } from "../src";
import { simplifiedCases } from "./simplified-cases";

export default function PowerTraceExpanderDebuggerFixture() {
  const solver = useMemo(
    () =>
      new PowerTraceExpanderSolver(
        structuredClone(simplifiedCases.inflationPushesSignal),
      ),
    [],
  );

  return <GenericSolverDebugger solver={solver} animationSpeed={30} />;
}
