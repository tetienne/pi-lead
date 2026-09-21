import assert from "node:assert/strict";
import { test } from "node:test";

import { createIsolatedFixturePolicy, MAX_ACTIVE_WORKERS } from "../src/policy.ts";

test("fixture policy denies egress and exposes no host filesystem, credentials, or control sockets", () => {
  const policy = createIsolatedFixturePolicy({
    taskId: "task-policy",
    assignmentId: "assignment-policy",
    workerId: "worker-policy",
  });

  assert.equal(MAX_ACTIVE_WORKERS, 2);
  assert.deepEqual(policy, {
    network: {
      allowedHosts: [],
      allowWebSockets: false,
    },
    filesystem: {
      hostMounts: [],
      guestWorkspace: "/workspace",
      privateWritablePaths: ["/workspace", "/tmp/pi-lead-worker-policy"],
    },
    environment: {
      PI_LEAD_TASK_ID: "task-policy",
      PI_LEAD_ASSIGNMENT_ID: "assignment-policy",
      PI_LEAD_WORKER_ID: "worker-policy",
    },
  });
  assert.equal("HERDR_SOCKET_PATH" in policy.environment, false);
  assert.equal("SSH_AUTH_SOCK" in policy.environment, false);
  assert.equal("OPENAI_API_KEY" in policy.environment, false);
});
