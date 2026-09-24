import type { VM } from "@earendil-works/gondolin";

import type { WorkerVerdict } from "../jev.ts";
import { WRITES_CODE, type Verification, type WorkerTask } from "../protocol.ts";
import { GUEST_WORKSPACE } from "../sandbox.ts";

/** Characters of the `verify` output kept for the Lead (and Jev). */
export const VERIFY_OUTPUT_TAIL = 2_000;
export const DEFAULT_VERIFY_TIMEOUT_MINUTES = 15;

/**
 * Should `finish` run the project's `verify` command? Only for work that
 * changes code, when the worker claims progress, and when the trusted project
 * config named a command. Decided from the host-written task, never from the model.
 */
export function shouldVerify(task: Pick<WorkerTask, "kind" | "verify">, status: WorkerVerdict): task is Pick<WorkerTask, "kind"> & { verify: string } {
  return (status === "done" || status === "partial") && WRITES_CODE.includes(task.kind) && typeof task.verify === "string" && task.verify.trim() !== "";
}

/**
 * Run `command` in the guest with the bash tool's shell and environment, at
 * /workspace. Never throws: a timeout or an exec error is exit code -1.
 */
export async function runVerification(
  vm: Pick<VM, "exec">,
  input: { command: string; shellPath: string; env: Record<string, string>; timeoutMinutes?: number; now?: () => number },
): Promise<Verification> {
  const now = input.now ?? Date.now;
  const started = now();
  const minutes = input.timeoutMinutes ?? DEFAULT_VERIFY_TIMEOUT_MINUTES;
  const controller = new AbortController();
  let tail = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const decoder = new TextDecoder();
  const run = (async () => {
    const proc = vm.exec([input.shellPath, "-lc", input.command], {
      cwd: GUEST_WORKSPACE,
      env: input.env,
      signal: controller.signal,
      stdout: "pipe",
      stderr: "pipe",
    });
    for await (const chunk of proc.output()) tail = (tail + decoder.decode(chunk.data, { stream: true })).slice(-VERIFY_OUTPUT_TAIL);
    return (await proc).exitCode;
  })();
  // The abort should end the command; the race makes sure `finish` never waits past the timeout.
  const expired = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve("timeout");
    }, minutes * 60_000);
  });
  let exitCode: number;
  try {
    const outcome = await Promise.race([run, expired]);
    exitCode = outcome === "timeout" ? -1 : outcome;
    if (outcome === "timeout") tail = `${tail}\n[PI Lead: stopped after ${minutes} minutes]`.slice(-VERIFY_OUTPUT_TAIL);
  } catch (error) {
    exitCode = -1;
    tail = `${tail}\n[PI Lead: could not run: ${error instanceof Error ? error.message : String(error)}]`.slice(-VERIFY_OUTPUT_TAIL);
  } finally {
    if (timer) clearTimeout(timer);
  }
  return { command: input.command, exitCode: Number.isInteger(exitCode) ? exitCode : -1, outputTail: tail, ms: Math.max(0, now() - started) };
}
