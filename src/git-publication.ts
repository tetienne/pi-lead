import { execFile } from "node:child_process";
import { createHash } from "node:crypto";

const TRUSTED_GIT = "/usr/bin/git";
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const TASK_BRANCH = /^pi-lead\/task-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

type GitOutput = { stdout: string; stderr: string };

function safeGitEnvironment(cwd: string): NodeJS.ProcessEnv {
  return {
    HOME: cwd,
    LANG: "C",
    LC_ALL: "C",
    PATH: "/usr/bin:/bin",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
}

function runGit(cwd: string, args: readonly string[], signal?: AbortSignal): Promise<GitOutput> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      TRUSTED_GIT,
      [
        "--no-pager",
        "--no-replace-objects",
        "-c", "core.hooksPath=/dev/null",
        "-c", "core.fsmonitor=false",
        "-c", "core.untrackedCache=false",
        "-c", "submodule.recurse=false",
        ...args,
      ],
      { cwd, encoding: "utf8", env: safeGitEnvironment(cwd), maxBuffer: 1024 * 1024, timeout: 60_000, signal },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`Trusted Git operation failed: ${stderr.trim() || error.message}`, { cause: error }));
          return;
        }
        resolvePromise({ stdout, stderr });
      },
    );
  });
}

async function gitText(cwd: string, args: readonly string[], signal?: AbortSignal): Promise<string> {
  return (await runGit(cwd, args, signal)).stdout.trim();
}

export type PublicationIntent = {
  operation: "PUSH_TASK_BRANCH";
  remoteName: string;
  remoteFingerprint: string;
  sourceRef: string;
  destinationRef: string;
  commit: string;
};

export type PublicationEvent =
  | { phase: "INTENDED"; intent: PublicationIntent }
  | {
      phase: "OBSERVED";
      intent: PublicationIntent;
      outcome: PublicationOutcome["status"];
      observedCommit?: string;
      detail?: string;
    };

export interface PublicationJournal {
  record(event: PublicationEvent): Promise<void>;
}

export type PublicationOutcome = {
  status: "PUBLISHED" | "ALREADY_PUBLISHED" | "BLOCKED" | "FAILED" | "UNCERTAIN";
  intent: PublicationIntent;
  detail?: string;
  observedCommit?: string;
};

export type HumanGatedOperation = "CREATE_PULL_REQUEST" | "MERGE" | "DEPLOY" | "PRIVILEGED";

export type HumanApprovalRequest = {
  operation: HumanGatedOperation;
  branchName: string;
  commit: string;
  fingerprint: string;
};

export type HumanApproval = { fingerprint: string };

export function requestHumanApproval(options: {
  operation: HumanGatedOperation;
  branchName: string;
  commit: string;
}): HumanApprovalRequest {
  if (!TASK_BRANCH.test(options.branchName) || !OBJECT_ID.test(options.commit)) {
    throw new Error("Human approval must bind a valid task branch and commit");
  }
  const fingerprint = createHash("sha256")
    .update(`${options.operation}\0${options.branchName}\0${options.commit}`)
    .digest("hex");
  return { ...options, fingerprint };
}

export function approvalMatches(request: HumanApprovalRequest, approval: HumanApproval): boolean {
  return approval.fingerprint === request.fingerprint;
}

function publicationIntent(options: {
  remoteName: string;
  remoteUrl: string;
  branchName: string;
  commit: string;
}): PublicationIntent {
  if (!REMOTE_NAME.test(options.remoteName)) throw new Error("Invalid configured Git remote name");
  if (!options.remoteUrl || options.remoteUrl.includes("\0") || options.remoteUrl.length > 4_096) {
    throw new Error("Invalid configured Git remote URL");
  }
  if (!TASK_BRANCH.test(options.branchName)) throw new Error("Publication permits only PI Lead task branches");
  if (!OBJECT_ID.test(options.commit)) throw new Error("Invalid task branch commit");
  const ref = `refs/heads/${options.branchName}`;
  return {
    operation: "PUSH_TASK_BRANCH",
    remoteName: options.remoteName,
    remoteFingerprint: createHash("sha256").update(options.remoteUrl).digest("hex"),
    sourceRef: ref,
    destinationRef: ref,
    commit: options.commit,
  };
}

async function remoteCommit(
  repositoryPath: string,
  intent: PublicationIntent,
  remoteUrl: string,
): Promise<string | undefined> {
  const output = await gitText(repositoryPath, ["ls-remote", "--heads", remoteUrl, intent.destinationRef]);
  if (!output) return undefined;
  const lines = output.split("\n").filter(Boolean);
  if (lines.length !== 1) throw new Error("Configured remote returned ambiguous task-branch state");
  const [commit, ref, ...extra] = lines[0]?.split(/\s+/) ?? [];
  if (!commit || !OBJECT_ID.test(commit) || ref !== intent.destinationRef || extra.length !== 0) {
    throw new Error("Configured remote returned invalid task-branch state");
  }
  return commit;
}

async function observe(
  journal: PublicationJournal | undefined,
  intent: PublicationIntent,
  outcome: PublicationOutcome,
): Promise<PublicationOutcome> {
  await journal?.record({
    phase: "OBSERVED",
    intent,
    outcome: outcome.status,
    ...(outcome.observedCommit ? { observedCommit: outcome.observedCommit } : {}),
    ...(outcome.detail ? { detail: outcome.detail } : {}),
  });
  return outcome;
}

/**
 * Push one already-reviewed local task branch. This deliberately has no knobs for
 * force, refspecs, tags, PRs, merges, deployment, or remote creation.
 */
export async function publishTaskBranch(options: {
  repositoryPath: string;
  configuredRemoteName?: string;
  configuredRemoteUrl?: string;
  configuredRemoteUrls?: readonly string[];
  branchName: string;
  commit: string;
  journal?: PublicationJournal;
  signal?: AbortSignal;
}): Promise<PublicationOutcome> {
  const remoteName = options.configuredRemoteName;
  const remoteUrls = options.configuredRemoteUrls ?? (options.configuredRemoteUrl ? [options.configuredRemoteUrl] : []);
  const remoteUrl = remoteUrls[0];
  const intent = publicationIntent({
    remoteName: remoteName ?? "unconfigured",
    remoteUrl: remoteUrl ?? "unconfigured",
    branchName: options.branchName,
    commit: options.commit,
  });
  if (!remoteName || remoteUrls.length === 0 || !remoteUrl) {
    return observe(options.journal, intent, {
      status: "BLOCKED", intent, detail: "No consuming-project publication remote is configured",
    });
  }
  if (remoteUrls.length !== 1) {
    return observe(options.journal, intent, {
      status: "BLOCKED", intent, detail: "Configured publication remote is ambiguous",
    });
  }
  const localCommit = await gitText(options.repositoryPath, ["rev-parse", "--verify", `${intent.sourceRef}^{commit}`], options.signal);
  if (localCommit !== intent.commit) {
    return observe(options.journal, intent, {
      status: "BLOCKED", intent, detail: "Local task branch no longer identifies the reviewed final commit",
    });
  }
  await options.journal?.record({ phase: "INTENDED", intent });
  let before: string | undefined;
  try {
    options.signal?.throwIfAborted();
    before = await remoteCommit(options.repositoryPath, intent, remoteUrl);
  } catch (error) {
    return observe(options.journal, intent, {
      status: "UNCERTAIN", intent, detail: error instanceof Error ? error.message : String(error),
    });
  }
  if (before === intent.commit) {
    return observe(options.journal, intent, { status: "ALREADY_PUBLISHED", intent, observedCommit: before });
  }
  if (before !== undefined) {
    return observe(options.journal, intent, {
      status: "BLOCKED", intent, observedCommit: before,
      detail: "Remote task branch already exists at a different commit; refusing to overwrite it",
    });
  }
  try {
    options.signal?.throwIfAborted();
    await runGit(options.repositoryPath, ["push", "--porcelain", "--no-verify", remoteUrl, `${intent.sourceRef}:${intent.destinationRef}`], options.signal);
  } catch (error) {
    try {
      const after = await remoteCommit(options.repositoryPath, intent, remoteUrl);
      if (after === intent.commit) {
        return observe(options.journal, intent, { status: "PUBLISHED", intent, observedCommit: after });
      }
      return observe(options.journal, intent, {
        status: "FAILED", intent, observedCommit: after,
        detail: error instanceof Error ? error.message : String(error),
      });
    } catch (reconciliationError) {
      return observe(options.journal, intent, {
        status: "UNCERTAIN", intent,
        detail: `Push failed and remote state could not be reconciled: ${reconciliationError instanceof Error ? reconciliationError.message : String(reconciliationError)}`,
      });
    }
  }
  try {
    const after = await remoteCommit(options.repositoryPath, intent, remoteUrl);
    if (after !== intent.commit) {
      return observe(options.journal, intent, {
        status: "UNCERTAIN", intent, observedCommit: after,
        detail: "Push returned successfully but the remote task branch did not match the reviewed commit",
      });
    }
    return observe(options.journal, intent, { status: "PUBLISHED", intent, observedCommit: after });
  } catch (error) {
    return observe(options.journal, intent, {
      status: "UNCERTAIN", intent,
      detail: `Push returned successfully but remote state could not be reconciled: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}
