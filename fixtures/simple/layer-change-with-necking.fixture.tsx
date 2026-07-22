import { PowerTraceExpanderDebugger } from "../PowerTraceExpanderDebugger";
import { simplifiedCases } from "../simplified-cases";

export default () => (
  <PowerTraceExpanderDebugger
    problem={simplifiedCases.layerChangeWithNecking}
    animationSpeed={20}
  />
);
