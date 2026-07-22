import { expect, test } from "bun:test";
import cosmosConfig from "../cosmos.config.json";

test("debugger catalog discovers both simple and complex fixtures", async () => {
  const fixturePaths: string[] = [];
  const fixtureGlob = new Bun.Glob("fixtures/**/*.fixture.tsx");
  for await (const path of fixtureGlob.scan({
    cwd: `${import.meta.dir}/..`,
    onlyFiles: true,
  })) {
    fixturePaths.push(path);
  }

  expect(cosmosConfig.fixtureFileSuffix).toBe("fixture");
  expect(fixturePaths.filter((path) => path.includes("/simple/"))).toHaveLength(
    4,
  );
  expect(
    fixturePaths.filter((path) => path.includes("/complex/")),
  ).toHaveLength(2);
  expect(fixturePaths).toContain(
    "fixtures/complex/rp2040-dual-motor.fixture.tsx",
  );
});
