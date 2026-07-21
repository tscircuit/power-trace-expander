import type {
  SimpleRouteConnection,
  SimpleRouteJson,
  SimplifiedPcbTrace,
} from "@tscircuit/core";

const getTraceNames = (trace: SimplifiedPcbTrace) =>
  [
    trace.connection_name,
    trace.source_trace_id,
    trace.rootConnectionName,
    ...(trace.mergedConnectionNames ?? []),
  ].filter((name): name is string => Boolean(name));

const findConnection = (
  problem: SimpleRouteJson,
  trace: SimplifiedPcbTrace,
) => {
  const traceNames = getTraceNames(trace);
  return problem.connections.find((connection) =>
    [
      connection.name,
      connection.source_trace_id,
      connection.rootConnectionName,
      ...(connection.mergedConnectionNames ?? []),
    ]
      .filter((name): name is string => Boolean(name))
      .some((name) => traceNames.includes(name)),
  );
};

const getNominalWidth = (
  problem: SimpleRouteJson,
  connection: SimpleRouteConnection,
) =>
  Math.max(
    connection.nominalTraceWidth ??
      connection.width ??
      problem.nominalTraceWidth ??
      problem.minTraceWidth,
    problem.minTraceWidth,
  );

export type TraceWidthMetric = {
  traceCount: number;
  totalLength: number;
  nominalLength: number;
  nominalCoverage: number;
  averageWidth: number;
};

export const getTraceWidthMetrics = (
  problem: SimpleRouteJson,
  traces: SimplifiedPcbTrace[],
) => {
  const accumulators = new Map<
    number,
    Omit<TraceWidthMetric, "nominalCoverage" | "averageWidth"> & {
      weightedWidth: number;
    }
  >();

  for (const trace of traces) {
    const connection = findConnection(problem, trace);
    if (!connection) continue;
    const nominalWidth = getNominalWidth(problem, connection);
    const metric = accumulators.get(nominalWidth) ?? {
      traceCount: 0,
      totalLength: 0,
      nominalLength: 0,
      weightedWidth: 0,
    };
    metric.traceCount++;

    for (let index = 0; index < trace.route.length - 1; index++) {
      const start = trace.route[index];
      const end = trace.route[index + 1];
      if (
        start?.route_type !== "wire" ||
        end?.route_type !== "wire" ||
        start.layer !== end.layer
      ) {
        continue;
      }
      const length = Math.hypot(end.x - start.x, end.y - start.y);
      const segmentWidth = Math.min(start.width, end.width);
      metric.totalLength += length;
      metric.weightedWidth += length * segmentWidth;
      if (segmentWidth >= nominalWidth - 1e-6) {
        metric.nominalLength += length;
      }
    }
    accumulators.set(nominalWidth, metric);
  }

  return new Map(
    [...accumulators].map(([nominalWidth, metric]) => [
      nominalWidth,
      {
        traceCount: metric.traceCount,
        totalLength: metric.totalLength,
        nominalLength: metric.nominalLength,
        nominalCoverage: metric.nominalLength / metric.totalLength,
        averageWidth: metric.weightedWidth / metric.totalLength,
      } satisfies TraceWidthMetric,
    ]),
  );
};
