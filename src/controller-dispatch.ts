import { join } from "node:path";

import { isRecord, readJsonIfPresent } from "./state-files.ts";

export async function waitForControllerDispatch(options: {
  stateDirectory: string;
  required: boolean;
  signal: AbortSignal;
  timeoutMs?: number;
}): Promise<void> {
  if (!options.required) return;
  const deadline = Date.now() + (options.timeoutMs ?? 40_000);
  while (Date.now() <= deadline) {
    options.signal.throwIfAborted();
    const dispatch = await readJsonIfPresent(join(options.stateDirectory, "dispatch.json"));
    if (isRecord(dispatch) && dispatch.admitted === true) return;
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new DOMException("Timed out waiting for durable controller admission", "TimeoutError");
}
