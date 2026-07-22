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
    12,
  );
  expect(
    fixturePaths.filter((path) => path.includes("/complex/")),
  ).toHaveLength(3);
  expect(fixturePaths).toContain(
    "fixtures/complex/rp2040-dual-motor.fixture.tsx",
  );
  expect(fixturePaths).toContain(
    "fixtures/complex/p-motor-a-upper.fixture.tsx",
  );
  expect(fixturePaths).toContain(
    "fixtures/simple/layer-change-with-necking.fixture.tsx",
  );
  expect(fixturePaths).toContain(
    "fixtures/simple/via-pair-elimination.fixture.tsx",
  );
  expect(fixturePaths).toContain(
    "fixtures/simple/clearance-shove-simplification.fixture.tsx",
  );
  expect(fixturePaths).toContain(
    "fixtures/simple/via-pair-obstacle-detour.fixture.tsx",
  );
  expect(fixturePaths).toContain(
    "fixtures/simple/routed-via-in-connected-pad.fixture.tsx",
  );
  expect(fixturePaths).toContain(
    "fixtures/simple/clustered-same-net-vias.fixture.tsx",
  );
  expect(fixturePaths).toContain(
    "fixtures/simple/power-trace-pad-clearance.fixture.tsx",
  );
});
