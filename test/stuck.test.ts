import assert from "node:assert/strict";
import { test } from "node:test";

import { createStuckDetector, normalizeCommand, steerMessage } from "../src/worker/stuck.ts";

function detector() {
  const steered: string[] = [];
  const stuck = createStuckDetector({ steer: (text) => void steered.push(text) });
  const run = (command: string, exitCode = 1) => stuck.record(command, exitCode);
  return { stuck, run, steered };
}

test("retries of one command compare equal despite cosmetic changes", () => {
  const base = normalizeCommand("npm test");
  for (const variant of ["  npm   test ", "npm test 2>&1", "npm test 2>&1 | tail -n 50", "npm test | tail -20", "cd /workspace && npm test", "cd api; cd .. && npm test | head", "npm test | cat"]) {
    assert.equal(normalizeCommand(variant), base, variant);
  }
  assert.notEqual(normalizeCommand("npm test -- a.test.ts"), base);
  assert.notEqual(normalizeCommand("npm test | grep FAIL"), base);
});

test("the same command failing three times, with no success and no file change in between, steers once", () => {
  const { run, steered } = detector();
  run("npm test");
  run("npm test 2>&1 | tail -20");
  assert.deepEqual(steered, []);
  run("npm test");
  assert.deepEqual(steered, [
    "PI Lead: you ran `npm test` 3 times with the same failure and changed no file in between. Step back: re-read the error, try a different approach, or finish with status blocked explaining what you tried.",
  ]);
});

test("a success of the command resets its count; other commands in between do not", () => {
  const { run, steered } = detector();
  run("npm test");
  run("npm test");
  run("npm test", 0);
  run("npm test");
  run("cat src/a.ts", 0);
  run("npm test");
  assert.deepEqual(steered, []);
  run("npm test");
  assert.equal(steered.length, 1);
});

test("a file change resets the per-command counts and the failure streak", () => {
  const { stuck, run, steered } = detector();
  run("npm test");
  run("npm test");
  stuck.progress();
  run("npm test");
  run("npm test");
  assert.deepEqual(steered, [], "two failures after the edit");

  const streak = detector();
  for (const command of ["a", "b", "c", "d", "e"]) streak.run(command);
  streak.stuck.progress();
  for (const command of ["f", "g", "h", "i", "j"]) streak.run(command);
  assert.deepEqual(streak.steered, [], "five failures after the edit");
  streak.run("k");
  assert.equal(streak.steered.length, 1);
});

test("a test-first loop (edit, tests fail, edit, tests fail) is never flagged", () => {
  const { stuck, run, steered } = detector();
  for (let index = 0; index < 20; index++) {
    stuck.progress();
    run("npm test");
  }
  run("npm test", 0);
  assert.deepEqual(steered, []);
});

test("six failures in a row with no file change steer, whatever the commands", () => {
  const { run, steered } = detector();
  for (const command of ["a", "b", "c", "d", "e"]) run(command);
  assert.deepEqual(steered, []);
  run("f");
  assert.equal(steered[0], steerMessage({ kind: "streak", failures: 6 }));
  assert.match(steered[0]!, /^PI Lead: your last 6 shell commands all failed and you changed no file in between\. Step back/);

  const broken = detector();
  for (const command of ["a", "b", "c"]) broken.run(command);
  broken.run("ls", 0);
  for (const command of ["d", "e", "f", "g", "h"]) broken.run(command);
  assert.deepEqual(broken.steered, [], "a success breaks the streak");
});

test("one steer per cycle; a reset starts a new one", () => {
  const { stuck, run, steered } = detector();
  for (let index = 0; index < 12; index++) run("npm test");
  assert.equal(steered.length, 1, "never nagged further in the same cycle");
  stuck.progress();
  for (let index = 0; index < 3; index++) run("npm test");
  assert.equal(steered.length, 1, "a file change does not start a new cycle");

  // A new prompt from the Lead or the user, or a reported result, starts over.
  stuck.reset();
  run("npm test");
  run("npm test");
  assert.equal(steered.length, 1, "the counts start over too");
  run("npm test");
  assert.equal(steered.length, 2);
});
