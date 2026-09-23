import assert from "node:assert/strict";
import { test } from "node:test";

import type { ShellRun } from "../src/jev.ts";
import { createStuckDetector, finishMessage, normalizeCommand, steerMessage } from "../src/worker/stuck.ts";

function detector(answer: boolean | undefined | ((runs: readonly ShellRun[]) => Promise<boolean | undefined>)) {
  const asked: ShellRun[][] = [];
  const steered: string[] = [];
  const notified: string[] = [];
  const stuck = createStuckDetector({
    judge: async (runs) => {
      asked.push([...runs]);
      return typeof answer === "function" ? answer(runs) : answer;
    },
    steer: (text) => void steered.push(text),
    notify: (text) => void notified.push(text),
  });
  const run = async (command: string, exitCode = 1, output?: string) =>
    stuck.record({ command, exitCode, ...(output ? { output } : {}) });
  return { stuck, run, asked, steered, notified };
}

test("retries of one command compare equal despite cosmetic changes", () => {
  const base = normalizeCommand("npm test");
  for (const variant of ["  npm   test ", "npm test 2>&1", "npm test 2>&1 | tail -n 50", "npm test | tail -20", "cd /workspace && npm test", "cd api; cd .. && npm test | head", "npm test | cat"]) {
    assert.equal(normalizeCommand(variant), base, variant);
  }
  assert.notEqual(normalizeCommand("npm test -- a.test.ts"), base);
  assert.notEqual(normalizeCommand("npm test | grep FAIL"), base);
});

test("the same command failing three times, with no success in between, asks Jev once", async () => {
  const { run, asked, steered } = detector(true);
  await run("npm test");
  await run("npm test 2>&1 | tail -20");
  assert.equal(asked.length, 0);
  await run("npm test", 1, "FAIL a.test.ts\nexpected 1 got 2");
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0]!.at(-1), { command: "npm test", exitCode: 1, output: "FAIL a.test.ts\nexpected 1 got 2" });
  assert.deepEqual(steered, [
    "PI Lead: you ran `npm test` 3 times with the same failure. Step back: re-read the error, try a different approach, or finish with status blocked explaining what you tried.",
  ]);
});

test("a success of the command resets its count; other commands in between do not", async () => {
  const { run, asked } = detector(true);
  await run("npm test");
  await run("npm test");
  await run("npm test", 0);
  await run("npm test");
  await run("cat src/a.ts", 0);
  await run("npm test");
  assert.equal(asked.length, 0);
  await run("npm test");
  assert.equal(asked.length, 1);
});

test("six failures in a row trigger the broader check", async () => {
  const { run, asked, steered } = detector(true);
  for (const command of ["a", "b", "c", "d", "e"]) await run(command);
  assert.equal(asked.length, 0);
  await run("f");
  assert.equal(asked.length, 1);
  assert.equal(asked[0]!.length, 6);
  assert.match(steered[0]!, /^PI Lead: your last 6 shell commands all failed\. Step back/);
});

test("after a check, the next one waits for three more shell commands, twice as many after each \"not stuck\"", async () => {
  const { run, asked } = detector(false);
  for (let index = 0; index < 3; index++) await run("npm test");
  assert.equal(asked.length, 1);
  for (let index = 0; index < 5; index++) await run("npm test");
  assert.equal(asked.length, 1, "cooldown");
  await run("npm test");
  assert.equal(asked.length, 2);
  for (let index = 0; index < 12; index++) await run("npm test");
  assert.equal(asked.length, 3);
  for (let index = 0; index < 72; index++) await run("npm test");
  assert.equal(asked.length, 5, "logarithmic in the number of failing commands, not linear");

  const steered = detector(true);
  for (let index = 0; index < 6; index++) await steered.run("npm test");
  assert.equal(steered.asked.length, 2, "a steer keeps the short cooldown");
});

test("a reset drops a check in flight and does not block the new cycle", async () => {
  let release!: (answer: boolean) => void;
  const first = new Promise<boolean>((resolve) => (release = resolve));
  let calls = 0;
  const { stuck, run, asked, steered } = detector(() => (++calls === 1 ? first : Promise.resolve(true)));
  await run("npm test");
  await run("npm test");
  const pending = run("npm test");
  stuck.reset();
  for (let index = 0; index < 3; index++) await run("npm test");
  assert.equal(asked.length, 2, "the new cycle checks without waiting for the stale check");
  assert.equal(steered.length, 1);
  release(true);
  await pending;
  assert.equal(steered.length, 1, "the stale check steers nothing");
});

test("Jev decides; without it only the same-command trigger counts", async () => {
  const no = detector(false);
  for (let index = 0; index < 3; index++) await no.run("npm test");
  assert.equal(no.asked.length, 1);
  assert.deepEqual(no.steered, []);

  const strict = detector(undefined);
  for (let index = 0; index < 3; index++) await strict.run("npm test");
  assert.equal(strict.steered.length, 1, "unavailable or unsure: the strict trigger stands");

  const broad = detector(undefined);
  for (const command of ["a", "b", "c", "d", "e", "f"]) await broad.run(command);
  assert.equal(broad.asked.length, 1);
  assert.deepEqual(broad.steered, [], "unavailable or unsure: six different failures may be exploration");

  const failing = detector(async () => {
    throw new Error("boom");
  });
  for (let index = 0; index < 3; index++) await failing.run("npm test");
  assert.equal(failing.steered.length, 1);
});

test("a second detection in the same cycle tells the worker to finish as blocked and warns the tab, then stops checking", async () => {
  const { stuck, run, asked, steered, notified } = detector(true);
  for (let index = 0; index < 3; index++) await run("npm test");
  for (let index = 0; index < 3; index++) await run("npm test");
  assert.equal(steered.length, 2);
  assert.equal(steered[1], finishMessage({ kind: "same_command", command: "npm test", failures: 6 }));
  assert.match(steered[1]!, /Stop now: call finish with status blocked/);
  assert.equal(notified.length, 1);
  assert.match(notified[0]!, /told to finish as blocked/);

  for (let index = 0; index < 6; index++) await run("npm test");
  assert.equal(asked.length, 2, "never killed, never nagged further");

  // A new prompt from the Lead or the user starts over.
  stuck.reset();
  for (let index = 0; index < 3; index++) await run("npm test");
  assert.equal(asked.length, 3);
  assert.equal(steered[2], steerMessage({ kind: "same_command", command: "npm test", failures: 3 }));
});
