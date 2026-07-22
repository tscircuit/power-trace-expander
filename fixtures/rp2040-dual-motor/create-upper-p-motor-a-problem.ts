import type { SimpleRouteJson } from "@tscircuit/core";
import rp2040DualMotorProblem from "./input.json";

export const UPPER_P_MOTOR_A_CONNECTION = "source_trace_146";

/**
 * Keeps the complete board context, including the signal traces that may need
 * to move out of the power corridor. The solver's onlyConnectionNames option
 * restricts the top-level scan to upper P_MOTOR_A while still allowing its
 * inflation phase to push a nearby blocker.
 */
export const createUpperPMotorAProblem = () => {
  const problem = structuredClone(
    rp2040DualMotorProblem,
  ) as unknown as SimpleRouteJson;
  if (
    !problem.connections.some(
      (connection) => connection.name === UPPER_P_MOTOR_A_CONNECTION,
    )
  ) {
    throw new Error("Upper P_MOTOR_A connection is missing from the fixture");
  }
  return problem;
};
