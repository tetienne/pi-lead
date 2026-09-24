import { spawn } from "node:child_process";

import { DEFAULT_CONFIG } from "../config.ts";
import type { WorkerVerdict } from "../jev.ts";
import { WRITES_CODE, type Verification, type WorkerTask } from "../protocol.ts";

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
 * Run `command` on the host in the worker's clone. Never throws: a timeout,
 * an abort (`signal`, the user stopping `finish`) or a spawn error is exit
 * code -1.
 */
export async function runVerification(
  input: { command: string; cwd: string; timeoutMinutes?: number; signal?: AbortSignal; now?: () => number },
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
  const stopReason = () => (input.signal?.aborted ? "aborted" : `stopped after ${minutes} minutes`);
  let exitCode = -1;
  try {
    exitCode = await new Promise<number>((resolve, reject) => {
      const proc = spawn("/bin/sh", ["-lc", input.command], { cwd: input.cwd, signal });
      proc.stdout.on("data", (chunk: Buffer) => (tail = (tail + chunk.toString()).slice(-VERIFY_OUTPUT_TAIL)));
      proc.stderr.on("data", (chunk: Buffer) => (tail = (tail + chunk.toString()).slice(-VERIFY_OUTPUT_TAIL)));
      proc.once("error", reject);
      proc.once("close", (code) => resolve(code ?? -1));
    });
  } catch (error) {
    note(signal.aborted ? stopReason() : `could not run: ${error instanceof Error ? error.message : String(error)}`);
    exitCode = -1;
  } finally {
    clearTimeout(timer);
  }
  return { command: input.command, exitCode, outputTail: tail, ms: Math.max(0, now() - started) };
}
