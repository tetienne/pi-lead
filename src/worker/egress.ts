import type { Judge } from "../jev.ts";

export function hostMatches(host: string, patterns: readonly string[]): boolean {
  const hostname = host.toLowerCase().replace(/:\d+$/, "");
  return patterns.some((pattern) => {
    const normalized = pattern.toLowerCase();
    return normalized.startsWith("*.") ? hostname.endsWith(normalized.slice(1)) : hostname === normalized;
  });
}

/**
 * Decide whether a guest HTTP request may leave the VM: the configured
 * allowlist first, then Jev with the ticket as context, then the human watching
 * the worker's tab. Human answers are remembered per method and host.
 */
export function createEgressPolicy(options: {
  allowedHosts: readonly string[];
  task: string;
  judge: Pick<Judge, "egress">;
  askHuman?: (question: string) => Promise<boolean>;
  log?: (line: string) => void;
}): (request: { method: string; url: string }) => Promise<boolean> {
  const remembered = new Map<string, boolean>();
  return async ({ method, url }) => {
    let host: string;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
      host = parsed.host;
    } catch {
      return false;
    }
    if (hostMatches(host, options.allowedHosts)) return true;
    const key = `${method} ${host}`;
    const known = remembered.get(key);
    if (known !== undefined) return known;

    const decision = await options.judge.egress({ task: options.task, method, url });
    let allowed: boolean;
    if (decision === "ask") {
      allowed = options.askHuman ? await options.askHuman(`Allow the sandbox to ${method} ${host}?`) : false;
      options.log?.(`egress ${key}: ${allowed ? "allowed" : "denied"} by human`);
    } else {
      allowed = decision === "allow";
      options.log?.(`egress ${key}: ${decision} by Jev`);
    }
    remembered.set(key, allowed);
    return allowed;
  };
}
