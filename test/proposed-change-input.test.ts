import assert from "node:assert/strict";
import { test } from "node:test";

import { parseProposedChangeInput } from "../src/proposed-change-input.ts";

test("change input names its committed base, mise checks, dependency destinations, and instruction", () => {
  assert.deepEqual(
    parseProposedChangeInput(
      "--base main --check test --check typecheck --allow registry.npmjs.org -- Update the value.",
    ),
    {
      namedBase: "main",
      validationTasks: ["test", "typecheck"],
      dependencyHosts: ["registry.npmjs.org"],
      instruction: "Update the value.",
    },
  );
});

test("change input refuses an implicit base, missing checks, and unstructured shell text", () => {
  assert.throws(
    () => parseProposedChangeInput("--check test -- Update it."),
    /--base/,
  );
  assert.throws(
    () => parseProposedChangeInput("--base main -- Update it."),
    /--check/,
  );
  assert.throws(
    () => parseProposedChangeInput("--base main --check test Update it."),
    /separate the instruction/,
  );
});
