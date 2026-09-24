import type { VM } from "@earendil-works/gondolin";

import { DEFAULT_CONFIG } from "../config.ts";
import type { WorkerVerdict } from "../jev.ts";
import { WRITES_CODE, type Verification, type WorkerTask } from "../protocol.ts";
import { GUEST_WORKSPACE } from "../sandbox.ts";

/** Characters of the `verify` output kept for the Lead (and Jev). */
export const VERIFY_OUTPUT_TAIL = 2_000;

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
 * /workspace. Never throws: a timeout, an abort (`signal`, the user stopping
 * `finish`) or an exec error is exit code -1.
 */
export async function runVerification(
  vm: Pick<VM, "exec">,
  input: { command: string; shellPath: string; env: Record<string, string>; timeoutMinutes?: number; signal?: AbortSignal; now?: () => number },
): Promise<Verification> {
  const now = input.now ?? Date.now;
  const started = now();
  const minutes = input.timeoutMinutes ?? DEFAULT_CONFIG.verifyTimeoutMinutes;
  // A referenced timer, unlike `AbortSignal.timeout`: it must fire even when nothing else keeps Node busy.
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), minutes * 60_000);
  const signal = AbortSignal.any([timeout.signal, ...(input.signal ? [input.signal] : [])]);
  let tail = "";
  const note = (text: string) => void (tail = `${tail}\n[PI Lead: ${text}]`.slice(-VERIFY_OUTPUT_TAIL));
  const decoder = new TextDecoder();
  const run = (async () => {
    const proc = vm.exec([input.shellPath, "-lc", input.command], { cwd: GUEST_WORKSPACE, env: input.env, signal, stdout: "pipe", stderr: "pipe" });
    for await (const chunk of proc.output()) tail = (tail + decoder.decode(chunk.data, { stream: true })).slice(-VERIFY_OUTPUT_TAIL);
    return (await proc).exitCode;
  })();
  // The abort should end the command; the race makes sure `finish` never waits past it.
  const stopped = new Promise<"stopped">((resolve) => {
    if (signal.aborted) resolve("stopped");
    signal.addEventListener("abort", () => resolve("stopped"), { once: true });
  });
  const stopReason = () => (input.signal?.aborted ? "aborted" : `stopped after ${minutes} minutes`);
  let exitCode = -1;
  try {
    const outcome = await Promise.race([run, stopped]);
    if (outcome === "stopped") note(stopReason());
    else exitCode = Number.isInteger(outcome) ? outcome : -1;
  } catch (error) {
    note(signal.aborted ? stopReason() : `could not run: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
  return { command: input.command, exitCode, outputTail: tail, ms: Math.max(0, now() - started) };
}
