import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { SandboxService } from "./config.ts";

const execFileAsync = promisify(execFile);

/**
 * A relay on `bridge` that forwards to the service's alias on an `--internal`
 * network: the service itself never gets a published port or internet access
 * (see docs/research/sandbox-boundary.md, 2026-09-24). Pinned by digest so a
 * socat tag change can't slip in.
 */
const SOCAT_IMAGE = "alpine/socat@sha256:24220ef2c80a2a421ea08e4624488e985330c421b6aa3329bae14b0933a1d403";

const LABEL = "pi-lead.task";

export type StartedService = { name: string; port: number; hostPort: number };

async function docker(args: string[], timeoutMs = 30_000): Promise<string> {
  const { stdout } = await execFileAsync("docker", args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 1 << 20 });
  return stdout;
}

const networkName = (id: string) => `pi-lead-${id}`;
const containerName = (id: string, service: string) => `pi-lead-${id}-${service}`;

/**
 * Starts one `--internal` network and, per service, a container on it plus a
 * socat relay published on 127.0.0.1. On any failure, everything created so
 * far is removed.
 */
export async function startServices(id: string, services: readonly SandboxService[]): Promise<StartedService[]> {
  if (services.length === 0) return [];
  try {
    const network = networkName(id);
    await docker(["network", "create", "--internal", "--label", `${LABEL}=${id}`, network]);
    const started: StartedService[] = [];
    for (const service of services) {
      const relay = `${containerName(id, service.name)}.relay`;
      // Pulls can take a while; the daemon does the pulling, not the sandbox.
      await docker(
        [
          "run",
          "-d",
          "--name",
          containerName(id, service.name),
          "--network",
          network,
          "--network-alias",
          service.name,
          "--label",
          `${LABEL}=${id}`,
          ...Object.entries(service.env ?? {}).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
          service.image,
        ],
        300_000,
      );
      await docker(
        [
          "run",
          "-d",
          "--name",
          relay,
          "--network",
          "bridge",
          "-p",
          `127.0.0.1::${service.port}`,
          "--label",
          `${LABEL}=${id}`,
          SOCAT_IMAGE,
          `tcp-listen:${service.port},fork,reuseaddr`,
          `tcp-connect:${service.name}:${service.port}`,
        ],
        300_000,
      );
      await docker(["network", "connect", network, relay]);
      const port = await docker(["port", relay, `${service.port}/tcp`]);
      const match = /^127\.0\.0\.1:(\d+)$/m.exec(port.trim());
      if (!match) throw new Error(`docker did not publish a host port for ${relay}: ${port.trim()}`);
      started.push({ name: service.name, port: service.port, hostPort: Number(match[1]!) });
    }
    return started;
  } catch (error) {
    await stopServices(id);
    throw new Error(`could not start sandbox services (is Docker running?): ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Removes every container and network labeled for `id`. Best-effort: a
 * worker's cleanup must never fail on this. Returns what is still there after
 * cleanup (empty when everything is gone), so a caller can warn the user.
 */
export async function stopServices(id: string): Promise<string[]> {
  const filter = `label=${LABEL}=${id}`;
  try {
    const containers = (await docker(["ps", "-aq", "--filter", filter])).split("\n").map((line) => line.trim()).filter(Boolean);
    if (containers.length) await docker(["rm", "-f", ...containers]);
  } catch {
    // best-effort cleanup
  }
  try {
    const networks = (await docker(["network", "ls", "-q", "--filter", filter])).split("\n").map((line) => line.trim()).filter(Boolean);
    for (const network of networks) await docker(["network", "rm", network]).catch(() => undefined);
  } catch {
    // best-effort cleanup
  }
  try {
    const containers = (await docker(["ps", "-a", "--filter", filter, "--format", "{{.Names}}"])).split("\n").map((line) => line.trim()).filter(Boolean);
    const networks = (await docker(["network", "ls", "--filter", filter, "--format", "{{.Name}}"])).split("\n").map((line) => line.trim()).filter(Boolean);
    return [...containers, ...networks];
  } catch (error) {
    return [`docker unreachable: ${error instanceof Error ? error.message : String(error)}`];
  }
}
