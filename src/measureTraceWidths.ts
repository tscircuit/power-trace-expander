import type {
  SimpleRouteConnection,
  SimpleRouteJson,
  SimplifiedPcbTrace,
} from "@tscircuit/core";

export const TRACE_WIDTH_COVERAGE_FRACTIONS = [
  0.25, 0.5, 0.75, 0.875, 0.9, 1,
] as const;

export type TraceWidthCoverageFraction =
  (typeof TRACE_WIDTH_COVERAGE_FRACTIONS)[number];

export type TraceWidthMetric = {
  traceCount: number;
  segmentCount: number;
  totalLength: number;
  nominalLength: number;
  nominalCoverage: number;
  averageWidth: number;
  minimumWidth: number;
  p05Width: number;
  p10Width: number;
  widthDeficitArea: number;
  normalizedWidthDeficit: number;
  longestBelowHalfNominalRun: number;
  longestUnderNominalRun: number;
  coverageByFraction: Record<TraceWidthCoverageFraction, number>;
};

export type TraceWidthMeasurementOptions = {
  /**
   * Circuit JSON assigns a segment the width of its first route point. The
   * endpoint-minimum mode is a stricter diagnostic that treats a narrow next
   * point as if it also narrowed the preceding segment.
   */
  segmentWidthSemantics?: "circuit-json" | "endpoint-minimum";
};

type SegmentMeasurement = { length: number; width: number };

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

const getLengthWeightedPercentile = (
  segments: SegmentMeasurement[],
  totalLength: number,
  percentile: number,
) => {
  if (segments.length === 0 || totalLength <= 0) return 0;
  const targetLength = totalLength * percentile;
  let accumulatedLength = 0;
  for (const segment of [...segments].sort((a, b) => a.width - b.width)) {
    accumulatedLength += segment.length;
    if (accumulatedLength >= targetLength) return segment.width;
  }
  return segments[segments.length - 1]!.width;
};

/**
 * Measures routed copper width by length, grouped by requested nominal width.
 * The default uses Circuit JSON's first-route-point segment semantics. Pass
 * `endpoint-minimum` to calculate an additional conservative lower bound.
 */
export const measureTraceWidths = (
  problem: SimpleRouteJson,
  traces: SimplifiedPcbTrace[],
  options: TraceWidthMeasurementOptions = {},
) => {
  const segmentWidthSemantics = options.segmentWidthSemantics ?? "circuit-json";
  const accumulators = new Map<
    number,
    {
      traceCount: number;
      totalLength: number;
      weightedWidth: number;
      longestBelowHalfNominalRun: number;
      longestUnderNominalRun: number;
      segments: SegmentMeasurement[];
    }
  >();

  for (const trace of traces) {
    const connection = findConnection(problem, trace);
    if (!connection) continue;
    const nominalWidth = getNominalWidth(problem, connection);
    const metric = accumulators.get(nominalWidth) ?? {
      traceCount: 0,
      totalLength: 0,
      weightedWidth: 0,
      longestBelowHalfNominalRun: 0,
      longestUnderNominalRun: 0,
      segments: [],
    };
    metric.traceCount++;
    let belowHalfNominalRun = 0;
    let underNominalRun = 0;

    for (let index = 0; index < trace.route.length - 1; index++) {
      const start = trace.route[index];
      const end = trace.route[index + 1];
      if (
        start?.route_type !== "wire" ||
        end?.route_type !== "wire" ||
        start.layer !== end.layer
      ) {
        belowHalfNominalRun = 0;
        underNominalRun = 0;
        continue;
      }
      const length = Math.hypot(end.x - start.x, end.y - start.y);
      if (length <= 1e-9) continue;
      const width =
        segmentWidthSemantics === "endpoint-minimum"
          ? Math.min(start.width, end.width)
          : start.width;
      metric.totalLength += length;
      metric.weightedWidth += length * width;
      metric.segments.push({ length, width });
      belowHalfNominalRun =
        width < nominalWidth * 0.5 - 1e-6 ? belowHalfNominalRun + length : 0;
      underNominalRun =
        width < nominalWidth - 1e-6 ? underNominalRun + length : 0;
      metric.longestBelowHalfNominalRun = Math.max(
        metric.longestBelowHalfNominalRun,
        belowHalfNominalRun,
      );
      metric.longestUnderNominalRun = Math.max(
        metric.longestUnderNominalRun,
        underNominalRun,
      );
    }
    accumulators.set(nominalWidth, metric);
  }

  return new Map<number, TraceWidthMetric>(
    [...accumulators].map(([nominalWidth, metric]) => {
      const coverageByFraction = Object.fromEntries(
        TRACE_WIDTH_COVERAGE_FRACTIONS.map((fraction) => [
          fraction,
          metric.totalLength === 0
            ? 1
            : metric.segments
                .filter(
                  (segment) => segment.width >= nominalWidth * fraction - 1e-6,
                )
                .reduce((sum, segment) => sum + segment.length, 0) /
              metric.totalLength,
        ]),
      ) as Record<TraceWidthCoverageFraction, number>;
      const nominalCoverage = coverageByFraction[1];
      const widthDeficitArea = metric.segments.reduce(
        (sum, segment) =>
          sum + segment.length * Math.max(0, nominalWidth - segment.width),
        0,
      );

      return [
        nominalWidth,
        {
          traceCount: metric.traceCount,
          segmentCount: metric.segments.length,
          totalLength: metric.totalLength,
          nominalLength: nominalCoverage * metric.totalLength,
          nominalCoverage,
          averageWidth:
            metric.totalLength === 0
              ? nominalWidth
              : metric.weightedWidth / metric.totalLength,
          minimumWidth:
            metric.segments.length === 0
              ? nominalWidth
              : Math.min(...metric.segments.map((segment) => segment.width)),
          p05Width: getLengthWeightedPercentile(
            metric.segments,
            metric.totalLength,
            0.05,
          ),
          p10Width: getLengthWeightedPercentile(
            metric.segments,
            metric.totalLength,
            0.1,
          ),
          widthDeficitArea,
          normalizedWidthDeficit:
            metric.totalLength === 0
              ? 0
              : widthDeficitArea / (metric.totalLength * nominalWidth),
          longestBelowHalfNominalRun: metric.longestBelowHalfNominalRun,
          longestUnderNominalRun: metric.longestUnderNominalRun,
          coverageByFraction,
        },
      ];
    }),
  );
};
