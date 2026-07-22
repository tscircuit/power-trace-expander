import { cleanupCases } from "../cleanup-cases";
import { PowerTraceCleanupDebugger } from "../PowerTraceCleanupDebugger";

export default () => (
  <PowerTraceCleanupDebugger
    problem={cleanupCases.powerTracePadClearance}
    desiredPadClearance={0.25}
  />
);
