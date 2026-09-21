import assert from "node:assert/strict";
import { test } from "node:test";

import { planningSkillPrompt } from "../src/planning-intake.ts";

test("turns a bounded planning idea into the real Matt skill entrypoint", () => {
  const prompt = planningSkillPrompt("  Plan safer release notes.  ");
  assert.match(prompt, /^\/ask-matt /);
  assert.match(prompt, /\/grill-with-docs/);
  assert.match(prompt, /\/research/);
  assert.match(prompt, /\/to-spec/);
  assert.match(prompt, /\/to-tickets/);
  assert.match(prompt, /human granularity approval/);
  assert.match(prompt, /Do not implement anything/);
  assert.doesNotMatch(prompt, /  /);
});
