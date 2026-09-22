import assert from "node:assert/strict";
import { test } from "node:test";

import {
  currentReleaseDeferrals,
  runCurrentReleaseHostMatrix,
  runHostMatrixScenario,
  runSupportedHostMatrix,
  supportedHostTarget,
  type HostScenarioEvidence,
  type HostScenarioIdentity,
} from "../src/host-matrix.ts";

const identity: HostScenarioIdentity = {
  taskId: "task-1",
  assignmentId: "assignment-1",
  workerId: "worker-1",
  vmId: "vm-1",
  piSessionId: "session-1",
};

function passedEvidence(prefix: string): HostScenarioEvidence {
  const artifact = (name: string) => ({ path: `/evidence/${prefix}-${name}.json`, identity });
  return {
    versions: { node: "24.14.1", pi: "0.86.1", gondolin: "0.12.0", mise: "2025.8.20-r0" },
    checks: {
      toolchainVersions: { status: "passed", artifact: artifact("versions") },
      credentials: { status: "passed", artifact: artifact("credentials") },
      mountNetwork: { status: "passed", artifact: artifact("confinement") },
      termination: { status: "passed", artifact: artifact("termination") },
      herdrFocus: { status: "passed", artifact: artifact("focus") },
    },
  };
}

const collectedArtifact = async () => true;

test("a compatible host scenario records every required isolation and visibility check", async () => {
  const target = supportedHostTarget("ubuntu-24.04-arm64");
  const result = await runHostMatrixScenario({
    target,
    identity,
    verifyArtifact: collectedArtifact,
    observedHost: { platform: "linux", architecture: "arm64", operatingSystem: "Ubuntu 24.04 LTS" },
    async execute(scenario) {
      assert.equal(scenario.target, target);
      assert.equal(scenario.identity, identity);
      assert.deepEqual(scenario.pins, {
        node: "24.14.1",
        pi: "0.86.1",
        gondolin: "0.12.0",
        mise: "2025.8.20-r0",
      });
      return passedEvidence(target.id);
    },
  });

  assert.equal(result.status, "DONE");
  assert.deepEqual(result.missingChecks, []);
  assert.equal(result.checks.herdrFocus.status, "passed");
});

test("a scenario on unavailable hardware is blocked without inferring compatibility", async () => {
  const target = supportedHostTarget("ubuntu-24.04-x64");
  let executed = false;
  const result = await runHostMatrixScenario({
    target,
    identity,
    verifyArtifact: collectedArtifact,
    observedHost: { platform: "darwin", architecture: "arm64", operatingSystem: "macOS" },
    async execute() {
      executed = true;
      return passedEvidence(target.id);
    },
  });

  assert.equal(executed, false);
  assert.equal(result.status, "BLOCKED");
  assert.deepEqual(result.missingChecks, [
    "toolchainVersions",
    "credentials",
    "mountNetwork",
    "termination",
    "herdrFocus",
  ]);
  assert.match(result.detail, /requires ubuntu-24.04-x64/i);
});

test("a Linux scenario requires Ubuntu 24.04 evidence, not merely a matching CPU", async () => {
  let executed = false;
  const result = await runHostMatrixScenario({
    target: supportedHostTarget("ubuntu-24.04-x64"),
    identity,
    verifyArtifact: collectedArtifact,
    observedHost: { platform: "linux", architecture: "x64", operatingSystem: "unknown" },
    async execute() {
      executed = true;
      return passedEvidence("unexpected");
    },
  });

  assert.equal(executed, false);
  assert.equal(result.status, "BLOCKED");
  assert.match(result.detail, /Ubuntu 24\.04 LTS/);
});

test("a host run stays blocked until the provider, confinement, cleanup, and focus evidence all pass", async () => {
  const result = await runHostMatrixScenario({
    target: supportedHostTarget("macos-arm64"),
    identity,
    verifyArtifact: collectedArtifact,
    observedHost: { platform: "darwin", architecture: "arm64", operatingSystem: "macOS" },
    async execute() {
      const evidence = passedEvidence("macos");
      evidence.checks.termination = { status: "blocked", detail: "VM host PID is unavailable" };
      return evidence;
    },
  });

  assert.equal(result.status, "BLOCKED");
  assert.deepEqual(result.missingChecks, ["termination"]);
  assert.match(result.detail, /VM host PID is unavailable/);
});

test("a host run blocks unpinned tool versions and artifacts that cannot be verified", async () => {
  const result = await runHostMatrixScenario({
    target: supportedHostTarget("macos-arm64"),
    identity,
    verifyArtifact: async () => false,
    observedHost: { platform: "darwin", architecture: "arm64", operatingSystem: "macOS" },
    async execute() {
      const evidence = passedEvidence("macos");
      evidence.versions.pi = "0.87.0";
      return evidence;
    },
  });

  assert.equal(result.status, "BLOCKED");
  assert.deepEqual(result.missingChecks, [
    "toolchainVersions",
    "credentials",
    "mountNetwork",
    "termination",
    "herdrFocus",
  ]);
  assert.match(result.detail, /toolchain versions/i);
  assert.match(result.detail, /collected and verified/i);
});

test("a host run accepts observed pinned versions independent of property order", async () => {
  const result = await runHostMatrixScenario({
    target: supportedHostTarget("macos-arm64"),
    identity,
    verifyArtifact: collectedArtifact,
    observedHost: { platform: "darwin", architecture: "arm64", operatingSystem: "macOS" },
    async execute() {
      return {
        ...passedEvidence("macos"),
        versions: { mise: "2025.8.20-r0", node: "24.14.1", gondolin: "0.12.0", pi: "0.86.1" },
      };
    },
  });

  assert.equal(result.status, "DONE");
});

test("the matrix retains unrun Linux targets as explicit blockers beside completed macOS evidence", async () => {
  const results = await runSupportedHostMatrix({
    identity,
    verifyArtifact: collectedArtifact,
    observedHost: { platform: "darwin", architecture: "arm64", operatingSystem: "macOS" },
    async execute(scenario) {
      return passedEvidence(scenario.target.id);
    },
  });

  assert.deepEqual(results.map((result) => result.target.id), [
    "macos-arm64",
    "ubuntu-24.04-x64",
    "ubuntu-24.04-arm64",
  ]);
  assert.deepEqual(results.map((result) => result.status), ["DONE", "BLOCKED", "BLOCKED"]);
});

test("the current release matrix covers macOS ChatGPT Pro only and names deferred targets", async () => {
  const results = await runCurrentReleaseHostMatrix({
    identity,
    verifyArtifact: collectedArtifact,
    observedHost: { platform: "darwin", architecture: "arm64", operatingSystem: "macOS" },
    async execute(scenario) {
      return passedEvidence(scenario.target.id);
    },
  });

  assert.deepEqual(results.map((result) => result.target.id), ["macos-arm64"]);
  assert.deepEqual(results.map((result) => result.status), ["DONE"]);
  assert.deepEqual(currentReleaseDeferrals(), [
    {
      target: "ubuntu-24.04-x64",
      reason: "Ubuntu 24.04 x86_64 acceptance is deferred from the current release.",
    },
    {
      target: "ubuntu-24.04-arm64",
      reason: "Ubuntu 24.04 arm64 acceptance is deferred from the current release.",
    },
    {
      target: "opencode-go",
      reason: "A successful OpenCode Go worker is deferred until included quota is available.",
    },
  ]);
});
