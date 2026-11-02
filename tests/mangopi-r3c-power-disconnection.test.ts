import { expect, test } from "bun:test";
import { mangopiR3cPowerDisconnectionConstructorTuple } from "../fixtures/mangopi-r3c-power-disconnection/getMangoPiR3cPowerDisconnectionInput";
import { PowerTraceExpanderSolver } from "../src";
import { PhysicalConnectivityInvariant } from "../src/PhysicalConnectivityInvariant";

const fixturePath = `${import.meta.dir}/../fixtures/mangopi-r3c-power-disconnection/powerTraceExpansionSolver_input.json`;

test("preserves MangoPi R3C physical endpoint connectivity during power expansion", async () => {
  const fixtureBytes = await Bun.file(fixturePath).arrayBuffer();
  expect(
    new Bun.CryptoHasher("sha256").update(fixtureBytes).digest("hex"),
  ).toBe("b5aebe80b7a7a80ee0c26f5aa5cd7585fcb8aae44e8f8bfb6f19420ad878ff93");

  const [inputProblem, options] = mangopiR3cPowerDisconnectionConstructorTuple;
  const inputTraces = inputProblem.traces ?? [];
  const connectivityInvariant = new PhysicalConnectivityInvariant(
    inputProblem,
    inputTraces,
  );
  const countConnectedToFirstEndpoint = (
    componentByEndpointKey: Record<string, string>,
    connectionIndex: number,
  ) => {
    const firstComponent = componentByEndpointKey[`${connectionIndex}:0`];
    return inputProblem.connections[connectionIndex]!.pointsToConnect.reduce(
      (count, _, endpointIndex) =>
        count +
        Number(
          componentByEndpointKey[`${connectionIndex}:${endpointIndex}`] ===
            firstComponent,
        ),
      0,
    );
  };
  const countFullyConnectedConnections = (
    componentByEndpointKey: Record<string, string>,
  ) =>
    inputProblem.connections.reduce(
      (count, connection, connectionIndex) =>
        count +
        Number(
          countConnectedToFirstEndpoint(
            componentByEndpointKey,
            connectionIndex,
          ) === connection.pointsToConnect.length,
        ),
      0,
    );

  expect(inputProblem.connections).toHaveLength(113);
  expect(
    inputProblem.connections.reduce(
      (count, connection) => count + connection.pointsToConnect.length,
      0,
    ),
  ).toBe(518);
  expect(inputTraces).toHaveLength(405);
  expect(
    inputTraces.reduce(
      (count, trace) =>
        count +
        trace.route.filter((routePoint) => routePoint.route_type === "via")
          .length,
      0,
    ),
  ).toBe(519);
  expect(inputProblem.layerCount).toBe(6);
  expect(inputProblem.differentialPairs).toHaveLength(2);
  expect(options).toMatchObject({ allowNewVias: false });
  expect(options.onlyConnectionNames).toHaveLength(20);
  expect(connectivityInvariant.baseline.endpointCount).toBe(518);
  expect(
    countFullyConnectedConnections(
      connectivityInvariant.baseline.componentByEndpointKey,
    ),
  ).toBe(107);
  expect(
    inputProblem.connections.reduce(
      (count, _, connectionIndex) =>
        count +
        countConnectedToFirstEndpoint(
          connectivityInvariant.baseline.componentByEndpointKey,
          connectionIndex,
        ),
      0,
    ),
  ).toBe(502);
  expect(
    countConnectedToFirstEndpoint(
      connectivityInvariant.baseline.componentByEndpointKey,
      4,
    ),
  ).toBe(95);

  const solver = new PowerTraceExpanderSolver(
    structuredClone(inputProblem),
    structuredClone(options),
  );
  solver.solve();

  expect(solver.solved).toBe(true);
  expect(solver.failed).toBe(false);
  expect(solver.error).toBeNull();
  expect(solver.iterations).toBeLessThanOrEqual(8_000_000);
  expect(solver.getOutput()).toHaveLength(405);
  expect(solver.stats).toMatchObject({
    budgetLimitedExpansion: true,
    cleanupCompleted: true,
    clearanceRepairCompleted: true,
    completionReason: "expansion_budget",
    connectivityRollbackCount: 0,
    connectivityValidationError: null,
    resultStatus: "best_effort",
  });
  expect(solver.sameNetContactRejectionCount).toBeGreaterThan(0);
  expect(solver.getOutput()).not.toEqual(inputTraces);

  const outputConnectivity = connectivityInvariant.validate(solver.getOutput());
  expect(outputConnectivity.candidate.endpointCount).toBe(518);
  expect(outputConnectivity.regressions).toEqual([]);
  expect(outputConnectivity.safe).toBe(true);
  expect(outputConnectivity.validationError).toBeUndefined();
  expect(
    countFullyConnectedConnections(
      outputConnectivity.candidate.componentByEndpointKey,
    ),
  ).toBeGreaterThanOrEqual(107);
  expect(
    inputProblem.connections.reduce(
      (count, _, connectionIndex) =>
        count +
        countConnectedToFirstEndpoint(
          outputConnectivity.candidate.componentByEndpointKey,
          connectionIndex,
        ),
      0,
    ),
  ).toBeGreaterThanOrEqual(502);
  expect(
    countConnectedToFirstEndpoint(
      outputConnectivity.candidate.componentByEndpointKey,
      4,
    ),
  ).toBeGreaterThanOrEqual(95);
}, 9_999_999);
