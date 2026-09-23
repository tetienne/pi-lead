import type { Judge } from "../jev.ts";

/**
 * Allowlisted hosts are trusted for downloads only: GET/HEAD, plus the POST
 * git uses to fetch over smart HTTP. Anything that can upload (a push, a
 * publish, a paste) goes to Jev and the human even on an allowlisted host.
 */
export function isDownload(method: string, url: URL): boolean {
  const verb = method.toUpperCase();
  if (verb === "GET" || verb === "HEAD") return true;
  return verb === "POST" && url.pathname.endsWith("/git-upload-pack");
}

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
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    const host = parsed.host;
    if (hostMatches(host, options.allowedHosts) && isDownload(method, parsed)) return true;
    const key = `${method} ${host}`;
    const known = remembered.get(key);
    if (known !== undefined) return known;

    const decision = await options.judge.egress({ task: options.task, method, url });
    let allowed: boolean;
    if (decision === "ask") {
      allowed = options.askHuman ? await options.askHuman(`Allow the sandbox to ${method} ${host}?`) : false;
      options.log?.(`egress ${key}: ${allowed ? "allowed" : "denied"} by human`);
      // Only a human answer covers the whole host; Jev caches per path itself.
      if (options.askHuman) remembered.set(key, allowed);
    } else {
      // Jev's own decisions are shown through the judge's `onDecision`, filtered by `jev.display`.
      allowed = decision === "allow";
    }
    return allowed;
  };
}
