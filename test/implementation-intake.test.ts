import assert from "node:assert/strict";
import { test } from "node:test";

import { createNaturalImplementationInputResolver } from "../src/implementation-intake.ts";

test("natural implementation intake derives internal repository controls", async () => {
  const resolve = createNaturalImplementationInputResolver({
    async currentBranch() { return "main"; },
    async specificationSources() { return [".scratch/welcome/spec.md"]; },
    async miseTasks() { return ["docs", "typecheck", "test", "deploy"]; },
  });

  assert.deepEqual(await resolve("  Add a welcome screen  ", "/consumer"), {
    namedBase: "main",
    validationTasks: ["test", "typecheck"],
    dependencyHosts: [],
    specSource: ".scratch/welcome/spec.md",
    instruction: "Add a welcome screen",
  });
});

test("natural implementation intake asks about product scope, not adapter parameters", async () => {
  const withoutSpec = createNaturalImplementationInputResolver({
    async currentBranch() { return "main"; },
    async specificationSources() { return []; },
    async miseTasks() { return ["test"]; },
  });
  await assert.rejects(
    withoutSpec("Add a welcome screen", "/consumer"),
    /approved specification.*scope must be agreed/i,
  );

  const ambiguousSpec = createNaturalImplementationInputResolver({
    async currentBranch() { return "main"; },
    async specificationSources() { return [".scratch/a/spec.md", ".scratch/b/spec.md"]; },
    async miseTasks() { return ["test"]; },
  });
  await assert.rejects(
    ambiguousSpec("Add a welcome screen", "/consumer"),
    /which feature or ticket/i,
  );
});

test("natural implementation intake never guesses a mutating mise task", async () => {
  const resolve = createNaturalImplementationInputResolver({
    async currentBranch() { return "main"; },
    async specificationSources() { return ["spec.md"]; },
    async miseTasks() { return ["deploy", "publish"]; },
  });

  await assert.rejects(
    resolve("Ship it", "/consumer"),
    /no standard validation task/i,
  );
});
