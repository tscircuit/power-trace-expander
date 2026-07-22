import { PowerTraceExpanderDebugger } from "../PowerTraceExpanderDebugger";
import {
  createUpperPMotorAProblem,
  UPPER_P_MOTOR_A_CONNECTION,
} from "../rp2040-dual-motor/create-upper-p-motor-a-problem";

const problem = createUpperPMotorAProblem();

export default () => (
  <PowerTraceExpanderDebugger
    problem={problem}
    solverOptions={{ onlyConnectionNames: [UPPER_P_MOTOR_A_CONNECTION] }}
    animationSpeed={10}
  />
);
