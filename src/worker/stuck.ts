import type { ShellRun } from "../jev.ts";

/**
 * Notices a worker that keeps repeating a failing approach, which burns the
 * user's model quota. Deterministic triggers on the shell commands the
 * host-side bash wrapper saw; Jev only confirms; the response is graduated and
 * never stops the worker: a steer, then a steer to finish as blocked and a
 * warning in the tab.
 */

/** Same normalized command failing this many times, with no success of it in between. */
export const SAME_COMMAND_FAILURES = 3;
/** This many shell commands in a row failing, whatever they are. */
export const FAILURE_STREAK = 6;
/** Shell commands to wait after a check before checking again; doubles after each "not stuck", to bound Jev calls. */
export const CHECK_COOLDOWN = 3;

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

/** First response: step back. */
export function steerMessage(trigger: StuckTrigger): string {
  const what =
    trigger.kind === "same_command"
      ? `you ran ${quote(trigger.command)} ${trigger.failures} times with the same failure`
      : `your last ${trigger.failures} shell commands all failed`;
  return `PI Lead: ${what}. Step back: re-read the error, try a different approach, or finish with status blocked explaining what you tried.`;
}

/** Second response, in the same run: finish now. */
export function finishMessage(trigger: StuckTrigger): string {
  const what =
    trigger.kind === "same_command"
      ? `you ran ${quote(trigger.command)} ${trigger.failures} times with the same failure`
      : `your last ${trigger.failures} shell commands all failed`;
  return `PI Lead: you were already told to step back, and ${what}. Stop now: call finish with status blocked, explaining what you tried and what failed.`;
}

/** The warning shown in the worker tab on the second detection. */
export function tabWarning(trigger: StuckTrigger): string {
  const what = trigger.kind === "same_command" ? `keeps failing on ${quote(trigger.command)}` : `had ${trigger.failures} failing shell commands in a row`;
  return `PI Lead: this worker ${what} after a warning; it was told to finish as blocked. It keeps running until it does or you stop it.`;
}

export type StuckDetector = {
  /** Record one shell command; resolves once any check it started is over. */
  record(run: ShellRun): Promise<void>;
  /** A new prompt (from the Lead or the user), or a reported result, starts a new cycle; a check in flight is dropped. */
  reset(): void;
};

export function createStuckDetector(options: {
  /** Jev's opinion; `undefined` when it is unavailable or unsure. */
  judge: (runs: readonly ShellRun[]) => Promise<boolean | undefined>;
  steer: (text: string) => void;
  notify: (text: string) => void;
}): StuckDetector {
  let runs: ShellRun[] = [];
  let failures = new Map<string, number>();
  let runsSinceCheck = Number.POSITIVE_INFINITY;
  let cooldown = CHECK_COOLDOWN;
  /** 0: nothing said yet, 1: steered, 2: told to finish (no more checks this cycle). */
  let level = 0;
  let checking = false;
  let cycle = 0;

  const triggerFor = (run: ShellRun): StuckTrigger | undefined => {
    const count = failures.get(normalizeCommand(run.command)) ?? 0;
    if (count >= SAME_COMMAND_FAILURES) return { kind: "same_command", command: run.command, failures: count };
    const recent = runs.slice(-FAILURE_STREAK);
    if (recent.length === FAILURE_STREAK && recent.every((entry) => entry.exitCode !== 0)) {
      return { kind: "streak", failures: FAILURE_STREAK };
    }
    return undefined;
  };

  return {
    async record(run) {
      runs = [...runs.slice(-(FAILURE_STREAK - 1)), run];
      const key = normalizeCommand(run.command);
      if (run.exitCode === 0) failures.delete(key);
      else failures.set(key, (failures.get(key) ?? 0) + 1);
      runsSinceCheck += 1;
      if (run.exitCode === 0 || level >= 2 || checking || runsSinceCheck < cooldown) return;
      const trigger = triggerFor(run);
      if (!trigger) return;

      checking = true;
      runsSinceCheck = 0;
      const started = cycle;
      try {
        let stuck: boolean | undefined;
        try {
          stuck = await options.judge(runs);
        } catch {
          stuck = undefined;
        }
        if (started !== cycle) return;
        // Without Jev only the strict trigger counts: six unrelated failures can be normal exploration.
        if (!(stuck ?? trigger.kind === "same_command")) {
          cooldown *= 2;
          return;
        }
        if (level === 0) {
          level = 1;
          options.steer(steerMessage(trigger));
        } else {
          level = 2;
          options.notify(tabWarning(trigger));
          options.steer(finishMessage(trigger));
        }
      } finally {
        if (started === cycle) checking = false;
      }
    },

    reset() {
      runs = [];
      failures = new Map();
      runsSinceCheck = Number.POSITIVE_INFINITY;
      cooldown = CHECK_COOLDOWN;
      level = 0;
      checking = false;
      cycle += 1;
    },
  };
}
