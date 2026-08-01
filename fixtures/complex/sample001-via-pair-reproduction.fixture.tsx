import { InteractiveGraphics } from "graphics-debug/react";
import { getSample001ViaPairReproduction } from "../sample001-via-pair/getSample001ViaPairReproduction";

export default function Sample001ViaPairReproductionFixture() {
  const { graphics } = getSample001ViaPairReproduction();
  return <InteractiveGraphics graphics={graphics} />;
}
