import { PowerTraceExpanderDebugger } from "../PowerTraceExpanderDebugger";
import { createSample003UnexpandedTraceProblem } from "../sample003-unexpanded-trace/createSample003UnexpandedTraceProblem";

const problem = createSample003UnexpandedTraceProblem();

export default function Sample003UnexpandedTraceFixture() {
  return (
    <PowerTraceExpanderDebugger
      problem={problem}
      solverOptions={{ allowNewVias: false }}
      animationSpeed={10}
    />
  );
}
