import {
  capturePhysicalConnectivity as captureCopperConnectivity,
  type PhysicalConnectivitySnapshot,
} from "circuit-json-to-connectivity-map";
import { ConnectionNameResolver } from "./ConnectionNameResolver";
import type {
  Obstacle,
  PowerTraceExpanderInput,
  SimpleRouteConnection,
  SimplifiedPcbTrace,
} from "./types";

export type { PhysicalConnectivitySnapshot } from "circuit-json-to-connectivity-map";

export type PhysicalConnectivityRegression = {
  baselineEndpointKeys: string[];
  baselineEndpointLabels: string[];
  candidateComponents: string[][];
};

export type PhysicalConnectivityValidation = {
  safe: boolean;
  candidate: PhysicalConnectivitySnapshot;
  regressions: PhysicalConnectivityRegression[];
  validationError?: string;
};

const getTraceConnectionNames = (trace: SimplifiedPcbTrace) =>
  [
    trace.pcb_trace_id,
    trace.connection_name,
    trace.source_trace_id,
    trace.rootConnectionName,
    ...(trace.mergedConnectionNames ?? []),
    ...(trace.connectsTo ?? []),
  ].filter((name): name is string => Boolean(name));

const getConnectionNames = (connection: SimpleRouteConnection) =>
  [
    connection.name,
    connection.source_trace_id,
    connection.rootConnectionName,
    ...(connection.mergedConnectionNames ?? []),
    connection.netConnectionName,
    ...connection.pointsToConnect.flatMap((point) => [
      point.pointId,
      point.pcb_port_id,
    ]),
  ].filter((name): name is string => Boolean(name));

const getObstacleConnectionNames = (obstacle: Obstacle) =>
  [
    obstacle.obstacleId,
    ...obstacle.connectedTo,
    ...(obstacle.offBoardConnectsTo ?? []),
  ].filter((name): name is string => Boolean(name));

const getDefaultViaDiameter = (inputProblem: PowerTraceExpanderInput) => {
  const holeDiameter =
    inputProblem.min_via_hole_diameter ?? inputProblem.minViaHoleDiameter ?? 0;
  return Math.max(
    holeDiameter,
    inputProblem.min_via_pad_diameter ??
      inputProblem.minViaPadDiameter ??
      inputProblem.minViaDiameter ??
      0.6,
  );
};

const getEndpointLabel = (
  connection: SimpleRouteConnection,
  connectionIndex: number,
  endpointIndex: number,
) => {
  const endpoint = connection.pointsToConnect[endpointIndex]!;
  return (
    endpoint.pointId ??
    endpoint.pcb_port_id ??
    `${connection.name}[${connectionIndex}:${endpointIndex}]`
  );
};

const createEndpointOnlySnapshot = (
  inputProblem: PowerTraceExpanderInput,
): PhysicalConnectivitySnapshot => {
  const endpointLabels: Record<string, string> = {};
  const componentByEndpointKey: Record<string, string> = {};
  const endpointComponents: string[][] = [];
  for (
    let connectionIndex = 0;
    connectionIndex < inputProblem.connections.length;
    connectionIndex++
  ) {
    const connection = inputProblem.connections[connectionIndex]!;
    for (
      let endpointIndex = 0;
      endpointIndex < connection.pointsToConnect.length;
      endpointIndex++
    ) {
      const endpointKey = `${connectionIndex}:${endpointIndex}`;
      endpointLabels[endpointKey] = getEndpointLabel(
        connection,
        connectionIndex,
        endpointIndex,
      );
      componentByEndpointKey[endpointKey] = endpointKey;
      endpointComponents.push([endpointKey]);
    }
  }
  return {
    endpointCount: Object.keys(endpointLabels).length,
    endpointLabels,
    componentByEndpointKey,
    endpointComponents,
  };
};

const stableSerialize = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
    .join(",")}}`;
};

/** Adapt solver aliases to the shared, geometry-only connectivity API. */
export const capturePhysicalConnectivity = (
  inputProblem: PowerTraceExpanderInput,
  routedTraces: SimplifiedPcbTrace[],
): PhysicalConnectivitySnapshot => {
  const resolver = new ConnectionNameResolver(inputProblem, routedTraces, {
    includePhysicalPositionAliases: true,
  });
  const endpoints = inputProblem.connections.flatMap(
    (connection, connectionIndex) => {
      const netNames = resolver.canonicalize(getConnectionNames(connection));
      if (netNames.length !== 1) {
        throw new Error(
          `Connection ${connection.name} resolved to ${netNames.length} canonical nets`,
        );
      }
      return connection.pointsToConnect.map((endpoint, endpointIndex) => ({
        endpointKey: `${connectionIndex}:${endpointIndex}`,
        endpointLabel: getEndpointLabel(
          connection,
          connectionIndex,
          endpointIndex,
        ),
        point: { x: endpoint.x, y: endpoint.y },
        layers: endpoint.layers ?? [endpoint.layer],
        netName: netNames[0]!,
      }));
    },
  );
  const traces = [...routedTraces, ...(inputProblem.fixedTraces ?? [])].map(
    (trace) => {
      const netNames = resolver.canonicalize(getTraceConnectionNames(trace));
      if (netNames.length !== 1) {
        throw new Error(
          `Trace ${trace.pcb_trace_id} resolved to ${netNames.length} canonical nets`,
        );
      }
      return {
        pcb_trace_id: trace.pcb_trace_id,
        netName: netNames[0]!,
        route: trace.route,
      };
    },
  );
  return captureCopperConnectivity({
    layerCount: inputProblem.layerCount,
    defaultViaDiameter: getDefaultViaDiameter(inputProblem),
    endpoints,
    obstacles: inputProblem.obstacles.map((obstacle) => ({
      ...obstacle,
      netNames: resolver.canonicalize(getObstacleConnectionNames(obstacle)),
    })),
    traces,
  });
};

/**
 * A safe output may merge input terminal components, but it may never split a
 * component that was physically connected in the input.
 */
export class PhysicalConnectivityInvariant {
  readonly baseline: PhysicalConnectivitySnapshot;
  private readonly inputProblem: PowerTraceExpanderInput;
  private readonly baselineCaptureError: string | null;
  private readonly baselineTraceSignature: string;

  constructor(
    inputProblem: PowerTraceExpanderInput,
    baselineTraces: SimplifiedPcbTrace[],
  ) {
    this.inputProblem = inputProblem;
    this.baselineTraceSignature = stableSerialize(baselineTraces);
    try {
      this.baseline = capturePhysicalConnectivity(inputProblem, baselineTraces);
      this.baselineCaptureError = null;
    } catch (error) {
      this.baseline = createEndpointOnlySnapshot(inputProblem);
      this.baselineCaptureError =
        error instanceof Error ? error.message : String(error);
    }
  }

  validate(
    candidateTraces: SimplifiedPcbTrace[],
  ): PhysicalConnectivityValidation {
    if (this.baselineCaptureError) {
      const unchanged =
        stableSerialize(candidateTraces) === this.baselineTraceSignature;
      return {
        safe: unchanged,
        candidate: this.baseline,
        regressions: [],
        validationError: unchanged
          ? `Connectivity validation is limited to exact trace preservation: ${this.baselineCaptureError}`
          : `Connectivity validation failed closed: ${this.baselineCaptureError}`,
      };
    }

    let candidate: PhysicalConnectivitySnapshot;
    try {
      candidate = capturePhysicalConnectivity(
        this.inputProblem,
        candidateTraces,
      );
    } catch (error) {
      return {
        safe: false,
        candidate: createEndpointOnlySnapshot(this.inputProblem),
        regressions: [],
        validationError: `Connectivity validation failed closed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    const regressions: PhysicalConnectivityRegression[] = [];

    for (const baselineEndpointKeys of this.baseline.endpointComponents) {
      if (baselineEndpointKeys.length < 2) continue;
      const candidateComponentsById = new Map<string, string[]>();
      for (const endpointKey of baselineEndpointKeys) {
        const candidateComponentId =
          candidate.componentByEndpointKey[endpointKey] ??
          `missing:${endpointKey}`;
        const endpointKeys =
          candidateComponentsById.get(candidateComponentId) ?? [];
        endpointKeys.push(endpointKey);
        candidateComponentsById.set(candidateComponentId, endpointKeys);
      }
      if (candidateComponentsById.size <= 1) continue;
      regressions.push({
        baselineEndpointKeys: [...baselineEndpointKeys],
        baselineEndpointLabels: baselineEndpointKeys.map(
          (endpointKey) => this.baseline.endpointLabels[endpointKey]!,
        ),
        candidateComponents: [...candidateComponentsById.values()],
      });
    }

    return {
      safe: regressions.length === 0,
      candidate,
      regressions,
    };
  }
}
