import { PowerTraceExpanderDebugger } from "../PowerTraceExpanderDebugger";
import { simplifiedCases } from "../simplified-cases";

export default function IntermediateWidthChannelFixture() {
  return (
    <PowerTraceExpanderDebugger
      problem={simplifiedCases.intermediateWidthChannel}
    />
  );
}
