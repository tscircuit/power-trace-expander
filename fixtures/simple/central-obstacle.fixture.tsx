import { PowerTraceExpanderDebugger } from "../PowerTraceExpanderDebugger";
import { simplifiedCases } from "../simplified-cases";

export default function CentralObstacleFixture() {
  return (
    <PowerTraceExpanderDebugger problem={simplifiedCases.centralObstacle} />
  );
}
