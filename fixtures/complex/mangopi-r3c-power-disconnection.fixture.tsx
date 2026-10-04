import { PowerTraceExpanderDebugger } from "../PowerTraceExpanderDebugger";
import { mangopiR3cPowerDisconnectionConstructorTuple } from "../mangopi-r3c-power-disconnection/getMangoPiR3cPowerDisconnectionInput";

const [inputProblem, options] = mangopiR3cPowerDisconnectionConstructorTuple;

export default function MangoPiR3cPowerDisconnectionFixture() {
  return (
    <PowerTraceExpanderDebugger
      problem={inputProblem}
      solverOptions={options}
      animationSpeed={8}
    />
  );
}
