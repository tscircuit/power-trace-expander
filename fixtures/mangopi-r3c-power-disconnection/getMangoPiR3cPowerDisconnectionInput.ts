import type { SimpleRouteJson } from "@tscircuit/core";
import type {
  PowerTraceExpanderInput,
  PowerTraceExpanderOptions,
} from "../../src";
import constructorTupleJson from "./powerTraceExpansionSolver_input.json";

export type MangoPiR3cPowerDisconnectionConstructorTuple = readonly [
  PowerTraceExpanderInput & SimpleRouteJson,
  PowerTraceExpanderOptions,
];

const isRecord = (candidate: unknown): candidate is Record<string, unknown> =>
  typeof candidate === "object" &&
  candidate !== null &&
  !Array.isArray(candidate);

const isConstructorTuple = (
  candidate: unknown,
): candidate is MangoPiR3cPowerDisconnectionConstructorTuple => {
  if (!Array.isArray(candidate) || candidate.length !== 2) return false;
  const [inputProblem, options] = candidate;
  return (
    isRecord(inputProblem) &&
    typeof inputProblem.layerCount === "number" &&
    Array.isArray(inputProblem.connections) &&
    Array.isArray(inputProblem.obstacles) &&
    Array.isArray(inputProblem.traces) &&
    isRecord(options) &&
    (options.allowNewVias === undefined ||
      typeof options.allowNewVias === "boolean") &&
    (options.onlyConnectionNames === undefined ||
      (Array.isArray(options.onlyConnectionNames) &&
        options.onlyConnectionNames.every(
          (connectionName) => typeof connectionName === "string",
        )))
  );
};

const constructorTuple: unknown = constructorTupleJson;

if (!isConstructorTuple(constructorTuple)) {
  throw new Error(
    "MangoPi R3C reproduction fixture is not a PowerTraceExpanderSolver constructor tuple",
  );
}

export const mangopiR3cPowerDisconnectionConstructorTuple = constructorTuple;
