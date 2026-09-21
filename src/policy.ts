export const MAX_ACTIVE_WORKERS = 2;

export type FixtureIdentity = {
  taskId: string;
  assignmentId: string;
  workerId: string;
};

export type IsolatedFixturePolicy = {
  network: {
    allowedHosts: readonly string[];
    allowWebSockets: false;
  };
  filesystem: {
    hostMounts: readonly string[];
    guestWorkspace: "/workspace";
    privateWritablePaths: readonly string[];
  };
  environment: Record<string, string>;
};

export function createIsolatedFixturePolicy(identity: FixtureIdentity): IsolatedFixturePolicy {
  return {
    network: {
      allowedHosts: [],
      allowWebSockets: false,
    },
    filesystem: {
      hostMounts: [],
      guestWorkspace: "/workspace",
      privateWritablePaths: ["/workspace", `/tmp/pi-lead-${identity.workerId}`],
    },
    environment: {
      PI_LEAD_TASK_ID: identity.taskId,
      PI_LEAD_ASSIGNMENT_ID: identity.assignmentId,
      PI_LEAD_WORKER_ID: identity.workerId,
    },
  };
}
