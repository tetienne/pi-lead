export type DependencyAccessDecision =
  | { decision: "ALLOW"; host: string }
  | { decision: "DENY"; host: string; detail: string };

export type ProposedChangePolicy = {
  network: {
    allowedHosts: readonly string[];
    allowWebSockets: false;
  };
  filesystem: {
    guestWorkspace: "/workspace";
    hostMounts: readonly [];
    privateWritablePaths: readonly string[];
  };
  validation: readonly {
    task: string;
    command: readonly ["mise", "run", string];
  }[];
  decideDependencyAccess(host: string): DependencyAccessDecision;
};

const HOST_PATTERN = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;
const MISE_TASK_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/;

function requireHost(host: string): string {
  if (
    !HOST_PATTERN.test(host) ||
    host.includes("..") ||
    host.includes(":") ||
    host.split(".").some((label) => label.length === 0 || label.length > 63)
  ) {
    throw new Error(`Invalid dependency host: ${host}`);
  }
  return host;
}

export function createProposedChangePolicy(options: {
  workerId: string;
  dependencyHosts: readonly string[];
  validationTasks: readonly string[];
}): ProposedChangePolicy {
  if (!SAFE_ID_PATTERN.test(options.workerId)) throw new Error("Invalid worker ID");
  const dependencyHosts = [...new Set(options.dependencyHosts.map(requireHost))];
  if (dependencyHosts.includes("chatgpt.com")) {
    dependencyHosts.splice(dependencyHosts.indexOf("chatgpt.com"), 1);
  }
  const validation = options.validationTasks.map((task) => {
    if (!MISE_TASK_PATTERN.test(task)) throw new Error(`Invalid mise task: ${task}`);
    return Object.freeze({
      task,
      command: Object.freeze(["mise", "run", task] as const),
    });
  });
  const allowedHosts = Object.freeze(["chatgpt.com", ...dependencyHosts]);
  const allowedDependencies = new Set(dependencyHosts);
  return {
    network: Object.freeze({
      allowedHosts,
      allowWebSockets: false as const,
    }),
    filesystem: Object.freeze({
      guestWorkspace: "/workspace" as const,
      hostMounts: Object.freeze([]) as readonly [],
      privateWritablePaths: Object.freeze([
        "/workspace",
        `/tmp/pi-lead-${options.workerId}`,
      ]),
    }),
    validation: Object.freeze(validation),
    decideDependencyAccess(host: string): DependencyAccessDecision {
      if (allowedDependencies.has(host)) return { decision: "ALLOW", host };
      return {
        decision: "DENY",
        host,
        detail: `Dependency destination ${host} is not explicitly allowed`,
      };
    },
  };
}
