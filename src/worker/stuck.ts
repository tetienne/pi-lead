/**
 * Notices a worker that keeps repeating a failing approach, which burns the
 * user's model quota. Deterministic: failing shell commands seen by the
 * host-side bash wrapper count, and a file written or edited through the
 * sandboxed tools clears them, so a test-first loop (edit, test fails, edit)
 * never counts. The response is one steer per cycle; the worker is never stopped.
 */

/** Same normalized command failing this many times, with no success of it and no file change in between. */
export const SAME_COMMAND_FAILURES = 3;
/** This many shell commands in a row failing, whatever they are, with no file change in between. */
export const FAILURE_STREAK = 6;

export type StuckTrigger = { kind: "same_command"; command: string; failures: number } | { kind: "streak"; failures: number };

/**
 * Collapse cosmetic variations so retries of one command compare equal:
 * whitespace, a leading `cd <dir> &&`, and output plumbing at the end
 * (`2>&1`, `| tail -n 50`, `| head`, `| cat`).
 */
export function normalizeCommand(command: string): string {
  let text = command.trim().replace(/\s+/g, " ");
  let previous: string;
  do {
    previous = text;
    text = text.replace(/^cd \S+ ?(?:&&|;) ?/, "");
  } while (text !== previous);
  return text.replace(/(?: ?2>&1| ?\| ?(?:tail|head)(?: -n ?\d+| -\d+| -c ?\d+)?| ?\| ?cat)+$/, "").trim();
}

const quote = (command: string) => {
  const line = command.trim().replace(/\s+/g, " ");
  return `\`${line.length > 200 ? `${line.slice(0, 200)}…` : line}\``;
};

export function steerMessage(trigger: StuckTrigger): string {
  const what =
    trigger.kind === "same_command"
      ? `you ran ${quote(trigger.command)} ${trigger.failures} times with the same failure and changed no file in between`
      : `your last ${trigger.failures} shell commands all failed and you changed no file in between`;
  return `PI Lead: ${what}. Step back: re-read the error, try a different approach, or finish with status blocked explaining what you tried.`;
}

export type StuckDetector = {
  /** Record one shell command; `exitCode` -1 means it did not complete. */
  record(command: string, exitCode: number): void;
  /** A file was written or edited: the failures so far were not a loop. */
  progress(): void;
  /** A new prompt (from the Lead or the user), or a reported result, starts a new cycle. */
  reset(): void;
};

export function createStuckDetector(options: { steer: (text: string) => void }): StuckDetector {
  let failures = new Map<string, number>();
  let streak = 0;
  let steered = false;

  const progress = () => {
    failures = new Map();
    streak = 0;
  };

  return {
    record(command, exitCode) {
      const key = normalizeCommand(command);
      if (exitCode === 0) {
        failures.delete(key);
        streak = 0;
        return;
      }
      const count = (failures.get(key) ?? 0) + 1;
      failures.set(key, count);
      streak += 1;
      if (steered) return;
      const trigger: StuckTrigger | undefined =
        count >= SAME_COMMAND_FAILURES
          ? { kind: "same_command", command, failures: count }
          : streak >= FAILURE_STREAK
            ? { kind: "streak", failures: streak }
            : undefined;
      if (!trigger) return;
      steered = true;
      options.steer(steerMessage(trigger));
    },

    progress,

    reset() {
      progress();
      steered = false;
    },
  };
}
