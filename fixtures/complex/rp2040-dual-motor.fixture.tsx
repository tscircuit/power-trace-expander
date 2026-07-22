import type { SimpleRouteJson } from "@tscircuit/core";
import rp2040DualMotorProblem from "../rp2040-dual-motor/input.json";
import { PowerTraceExpanderDebugger } from "../PowerTraceExpanderDebugger";

export default function Rp2040DualMotorFixture() {
  return (
    <PowerTraceExpanderDebugger
      problem={rp2040DualMotorProblem as unknown as SimpleRouteJson}
      animationSpeed={8}
    />
  );
}
