type ProcessProbe = (pid: number) => boolean;

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}

export async function observeProcessExit(
  pid: number | null,
  timeoutMs: number,
  pollIntervalMs = 50,
  probe: ProcessProbe = processExists,
): Promise<boolean> {
  if (pid === null) return false;
  const deadline = Date.now() + timeoutMs;
  while (probe(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return true;
}
