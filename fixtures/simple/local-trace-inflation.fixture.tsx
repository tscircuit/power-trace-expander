import { PowerTraceExpanderDebugger } from "../PowerTraceExpanderDebugger";
import { simplifiedCases } from "../simplified-cases";

export default function LocalTraceInflationFixture() {
  return (
    <PowerTraceExpanderDebugger
      problem={simplifiedCases.inflationPushesSignal}
    />
  );
}
