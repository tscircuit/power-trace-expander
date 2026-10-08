import { createFragmentedConnectedPadNeckdownProblem } from "../fragmented-connected-pad-neckdown/createFragmentedConnectedPadNeckdownProblem";
import { PowerTraceExpanderDebugger } from "../PowerTraceExpanderDebugger";

export default () => (
  <PowerTraceExpanderDebugger
    problem={createFragmentedConnectedPadNeckdownProblem()}
    solverOptions={{ allowNewVias: false }}
  />
);
