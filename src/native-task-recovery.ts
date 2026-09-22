import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import {
  TaskRecordStore,
  type DurableTaskRecord,
  type RecoveryRuntime,
  type TaskIdentity,
} from "./task-recovery.ts";
import { isRecord, readJsonIfPresent, writeJsonAtomically } from "./state-files.ts";

const execFileAsync = promisify(execFile);

function findArrayField(value: unknown, field: string): unknown[] | undefined {
  if (!isRecord(value)) return undefined;
  if (Array.isArray(value[field])) return value[field];
  for (const nested of Object.values(value)) {
    const found = findArrayField(nested, field);
    if (found) return found;
  }
  return undefined;
}

function taskDirectory(root: string, record: DurableTaskRecord): string {
  const directory = resolve(root, record.diagnostics.logDirectory);
  const fromRoot = relative(resolve(root), directory);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("Recovery task directory must remain inside PI Lead state");
  }
  return directory;
}

async function waitForTermination(directory: string, vmId: string): Promise<boolean> {
  const deadline = Date.now() + 40_000;
  while (Date.now() <= deadline) {
    const value = await readJsonIfPresent(join(directory, "termination.json"));
    if (isRecord(value) && value.vmId === vmId && value.terminated === true) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  return false;
}

class NativeRecoveryRuntime implements RecoveryRuntime {
  readonly #cwd: string;
  readonly #directory: string;

  constructor(options: { cwd: string; directory: string }) {
    this.#cwd = options.cwd;
    this.#directory = options.directory;
  }

  async vm(identity: TaskIdentity) {
    const termination = await readJsonIfPresent(join(this.#directory, "termination.json"));
    if (isRecord(termination) && termination.vmId === identity.vmId && termination.terminated === true) {
      return { state: "STOPPED" as const, identity };
    }
    const resources = await readJsonIfPresent(join(this.#directory, "resources.json"));
    if (isRecord(resources) && resources.workerId === identity.workerId && resources.vmId === identity.vmId) {
      return { state: "RUNNING" as const, identity };
    }
    return { state: "ABSENT" as const };
  }

  async pi(identity: TaskIdentity) {
    const vm = await this.vm(identity);
    return vm.state === "RUNNING"
      ? { state: "RUNNING" as const, identity }
      : vm.state === "STOPPED"
        ? { state: "STOPPED" as const, identity }
        : { state: "ABSENT" as const };
  }

  async herdrTab(identity: TaskIdentity) {
    const { stdout } = await execFileAsync("herdr", ["tab", "list"], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 10_000,
    });
    const value = stdout.trim() ? JSON.parse(stdout) as unknown : undefined;
    const present = (findArrayField(value, "tabs") ?? []).some(
      (tab) => isRecord(tab) && tab.tab_id === identity.tabId,
    );
    return { state: present ? "PRESENT" as const : "ABSENT" as const, identity };
  }

  async git(branchName: string) {
    const ref = `refs/heads/${branchName}`;
    try {
      const { stdout } = await execFileAsync("/usr/bin/git", ["rev-parse", "--verify", ref], {
        cwd: this.#cwd,
        encoding: "utf8",
        env: { HOME: this.#cwd, PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
        timeout: 10_000,
      });
      return { commit: stdout.trim() };
    } catch {
      return {};
    }
  }

  async terminateVm(identity: TaskIdentity): Promise<boolean> {
    await writeJsonAtomically(join(this.#directory, "cancel.json"), { reason: "RECOVERY" });
    return waitForTermination(this.#directory, identity.vmId);
  }
}

export async function recoverNativeInterruptedTasks(options: {
  cwd: string;
  stateRoot?: string;
}) {
  const root = options.stateRoot ?? process.env.PI_LEAD_STATE_DIR ?? join(homedir(), ".local", "state", "pi-lead");
  const store = new TaskRecordStore({ root });
  const results = [];
  for (const taskId of await store.listInterruptedTaskIds()) {
    const record = await store.load(taskId);
    if (!record) continue;
    const runtime = new NativeRecoveryRuntime({ cwd: options.cwd, directory: taskDirectory(root, record) });
    const recovered = await store.reconcile(taskId, runtime);
    results.push({ taskId, reason: recovered.reason, resumeAllowed: recovered.resumeAllowed });
  }
  return results;
}
