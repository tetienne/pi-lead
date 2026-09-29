import { checkList, type MergeMethod, type Workspace } from "./workspace.ts";

/**
 * Merging workers' green PRs, one at a time (mattpocock/skills#493: parallel
 * branches merged at once break each other). Every step is gh's own: `gh pr
 * update-branch` brings the PR up to date with its base, `gh pr checks
 * --watch` waits for CI on the new head, `gh pr merge --match-head-commit`
 * merges exactly the head that was green, with a method the repository
 * allows. The delegator runs these one after another and never two at once.
 */

export type MergeTarget = {
  /** What the Lead passed: a worker id, title or branch, or a PR number or URL. */
  ref: string;
  /** The gh selector: the PR's URL or number. */
  pr: string;
  repoRoot: string;
  /** The worker's remote branch, which its fix instructions name. */
  branch?: string;
  /** Types a message into the PR's worker; returns why it could not. Absent when no worker is open for the PR. */
  sendBack?(text: string): Promise<string | undefined>;
};

export type MergeStep =
  | { merged: true; url: string }
  | { merged: false; text: string };

export type MergeDeps = {
  workspace: Workspace;
  /** The user's method; otherwise the first the repository allows, in gh's own order. */
  method?: MergeMethod;
  /** How long to wait for checks to register on a new head before concluding it runs none. */
  graceMs: number;
  sleep(ms: number): Promise<void>;
};

/** Checks can take a few seconds to register on a new head. */
const GRACE_TRIES = 3;

export async function mergeOne(target: MergeTarget, deps: MergeDeps): Promise<MergeStep> {
  const { workspace, graceMs } = deps;
  const { repoRoot, pr } = target;
  const stop = (text: string): MergeStep => ({ merged: false, text });
  /**
   * A conflict or red CI is the worker's to fix; without a worker it is the user's. `evidence`
   * (repo-controlled check names and links) goes to the worker only.
   */
  const problem = async (what: string, instructions: string, evidence = ""): Promise<MergeStep> => {
    if (!target.sendBack) return stop(`${what}. No worker is open for it: tell the user.`);
    const unsent = await target.sendBack(`${what}${evidence}. ${instructions}`);
    if (unsent === undefined) return stop(`${what}; sent back to its worker, which reports again once it is fixed.`);
    return stop(`${what}. ${unsent} Tell the user.`);
  };

  const view = await workspace.prView({ repoRoot, pr });
  if ("error" in view) return stop(`Could not read PR ${pr}: ${view.error}`);
  if (view.state === "MERGED") return { merged: true, url: view.url };
  if (view.state === "CLOSED") return stop(`${view.url} is closed`);
  // GitHub does not merge a draft.
  if (view.isDraft) {
    const ready = await workspace.prReady({ repoRoot, pr });
    if (ready.error) return stop(`Could not mark ${view.url} ready for review: ${ready.error}`);
  }

  const update = await workspace.updateBranch({ repoRoot, pr });
  if (update.state === "conflict") {
    return problem(
      `${view.url} conflicts with ${view.base} now that the PRs before it are merged`,
      `Run \`git fetch origin && git merge origin/${view.base}\` on your branch, resolve the conflicts, commit, push${target.branch ? ` to ${target.branch}` : ""}, wait for CI with \`gh pr checks --watch\`, then call \`finish\` again.`,
    );
  }
  if (update.state === "error") return stop(`Could not update ${view.url} from ${view.base}: ${update.error}`);

  let checks: Awaited<ReturnType<Workspace["prChecks"]>>;
  for (let tries = 0; ; tries += 1) {
    await workspace.watchChecks({ repoRoot, pr });
    checks = await workspace.prChecks({ repoRoot, branch: pr });
    // No checks yet on a head the update just made is not "no CI": they may not have registered.
    const fresh = checks.head !== undefined && checks.head !== view.head;
    if (checks.state === "none" && fresh && tries < GRACE_TRIES) {
      await deps.sleep(graceMs);
      continue;
    }
    break;
  }
  if (checks.state === "error") return stop(`Could not read the checks of ${view.url}: ${checks.error}`);
  if (!checks.head) return stop(`Could not read the head of ${view.url}`);
  if (checks.state === "fail") {
    return problem(
      `CI failed on ${view.url} after it was updated from ${view.base} (new head ${checks.head}, ${checks.failed.length} failed check${checks.failed.length === 1 ? "" : "s"})`,
      `The update is a merge commit on the remote branch: run \`git pull --no-rebase origin ${target.branch ?? "<your branch>"}\` first, then fix it, commit, push, wait for CI with \`gh pr checks --watch\`, and call \`finish\` again.`,
      `: ${checkList(checks.failed).join(", ")}`,
    );
  }
  if (checks.state === "pending") return stop(`CI is still pending on ${view.url} (head ${checks.head})`);

  let method = deps.method;
  if (!method) {
    const allowed = await workspace.mergeMethods(repoRoot);
    if ("error" in allowed) return stop(`Could not read the repository's merge methods: ${allowed.error}`);
    method = allowed.methods[0];
    if (!method) return stop("The repository allows no merge method");
  }
  const merged = await workspace.mergePr({ repoRoot, pr, method, head: checks.head });
  if (merged.error) return stop(`gh could not merge ${view.url}: ${merged.error}`);
  // A merge queue or a branch rule can accept the merge without merging yet.
  const after = await workspace.prView({ repoRoot, pr });
  if ("error" in after || after.state !== "MERGED") {
    return stop(`${view.url} is not merged yet (a merge queue or auto-merge may hold it): check it with \`gh pr view ${pr}\``);
  }
  return { merged: true, url: view.url };
}
