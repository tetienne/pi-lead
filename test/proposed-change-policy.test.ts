import assert from "node:assert/strict";
import { test } from "node:test";

import { createProposedChangePolicy } from "../src/proposed-change-policy.ts";

test("dependency destinations and mise tasks are explicit immutable policy inputs", () => {
  const policy = createProposedChangePolicy({
    workerId: "worker-1",
    dependencyHosts: ["registry.npmjs.org", "github.com"],
    validationTasks: ["test", "typecheck"],
  });

  assert.deepEqual(policy.network.allowedHosts, [
    "chatgpt.com",
    "registry.npmjs.org",
    "github.com",
  ]);
  assert.deepEqual(policy.validation, [
    { task: "test", command: ["mise", "run", "test"] },
    { task: "typecheck", command: ["mise", "run", "typecheck"] },
  ]);
  assert.deepEqual(policy.filesystem, {
    guestWorkspace: "/workspace",
    hostMounts: [],
    privateWritablePaths: ["/workspace", "/tmp/pi-lead-worker-1"],
  });

  assert.deepEqual(policy.decideDependencyAccess("registry.npmjs.org"), {
    decision: "ALLOW",
    host: "registry.npmjs.org",
  });
  assert.deepEqual(policy.decideDependencyAccess("packages.example.com"), {
    decision: "DENY",
    host: "packages.example.com",
    detail: "Dependency destination packages.example.com is not explicitly allowed",
  });
  assert.deepEqual(policy.network.allowedHosts, [
    "chatgpt.com",
    "registry.npmjs.org",
    "github.com",
  ]);
});

test("policy rejects URL-shaped destinations and command-shaped mise tasks", () => {
  assert.throws(
    () =>
      createProposedChangePolicy({
        workerId: "worker-1",
        dependencyHosts: ["https://registry.npmjs.org/path"],
        validationTasks: ["test"],
      }),
    /Invalid dependency host/,
  );
  assert.throws(
    () =>
      createProposedChangePolicy({
        workerId: "worker-1",
        dependencyHosts: [],
        validationTasks: ["test; curl attacker.example"],
      }),
    /Invalid mise task/,
  );
});
