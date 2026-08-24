import { expect, test } from "bun:test";
import { mangopiR3cPowerDisconnectionConstructorTuple } from "../fixtures/mangopi-r3c-power-disconnection/getMangoPiR3cPowerDisconnectionInput";
import { PowerTraceExpanderSolver } from "../src";
import { getPhysicalEndpointConnectivity } from "./helpers/getPhysicalEndpointConnectivity";

const fixturePath = `${import.meta.dir}/../fixtures/mangopi-r3c-power-disconnection/powerTraceExpansionSolver_input.json`;

const getConnectionConnectivity = (
  report: ReturnType<typeof getPhysicalEndpointConnectivity>,
  connectionName: string,
) => {
  const connection = report.connections.find(
    (candidate) => candidate.connectionName === connectionName,
  );
  if (!connection) {
    throw new Error(`Missing physical connectivity for ${connectionName}`);
  }
  return connection;
};

test("preserves MangoPi R3C physical endpoint connectivity during power expansion", async () => {
  const fixtureBytes = await Bun.file(fixturePath).arrayBuffer();
  expect(
    new Bun.CryptoHasher("sha256").update(fixtureBytes).digest("hex"),
  ).toBe("b5aebe80b7a7a80ee0c26f5aa5cd7585fcb8aae44e8f8bfb6f19420ad878ff93");

  const [inputProblem, options] = mangopiR3cPowerDisconnectionConstructorTuple;
  const inputTraces = inputProblem.traces ?? [];
  const inputConnectivity = getPhysicalEndpointConnectivity({
    inputProblem,
    routedTraces: inputTraces,
  });
  const inputGroundConnectivity = getConnectionConnectivity(
    inputConnectivity,
    "source_net_0",
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
  expect(inputConnectivity).toMatchObject({
    checkedConnectionCount: 113,
    connectedConnectionCount: 107,
    checkedEndpointCount: 518,
    connectedEndpointCount: 502,
  });
  expect(inputGroundConnectivity).toMatchObject({
    checkedEndpointCount: 99,
    connectedEndpointCount: 95,
  });

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
    resultStatus: "best_effort",
  });
  expect(solver.sameNetContactRejectionCount).toBeGreaterThan(0);

  const outputProblem = {
    ...structuredClone(inputProblem),
    traces: solver.getOutput(),
  };
  const outputConnectivity = getPhysicalEndpointConnectivity({
    inputProblem: outputProblem,
    routedTraces: outputProblem.traces,
  });
  const outputGroundConnectivity = getConnectionConnectivity(
    outputConnectivity,
    "source_net_0",
  );
  expect(outputConnectivity.checkedConnectionCount).toBe(113);
  expect(outputConnectivity.checkedEndpointCount).toBe(518);
  for (const inputConnection of inputConnectivity.connections) {
    const outputConnection = getConnectionConnectivity(
      outputConnectivity,
      inputConnection.connectionName,
    );
    expect(outputConnection.connectedEndpointCount).toBeGreaterThanOrEqual(
      inputConnection.connectedEndpointCount,
    );
  }
  expect(outputGroundConnectivity.checkedEndpointCount).toBe(99);
  expect(
    outputGroundConnectivity.connectedEndpointCount,
  ).toBeGreaterThanOrEqual(inputGroundConnectivity.connectedEndpointCount);
}, 9_999_999);
