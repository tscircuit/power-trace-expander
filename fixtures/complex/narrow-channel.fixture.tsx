import { PowerTraceExpanderDebugger } from "../PowerTraceExpanderDebugger";
import { simplifiedCases } from "../simplified-cases";

export default function NarrowChannelFixture() {
  return (
    <PowerTraceExpanderDebugger
      problem={simplifiedCases.narrowChannelRetreat}
    />
  );
}
