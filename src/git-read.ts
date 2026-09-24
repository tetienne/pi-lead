import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { truncateHead, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const execFileAsync = promisify(execFile);

const SUBCOMMANDS = new Set(["rev-parse", "log", "diff", "show", "status", "worktree"]);
const NO_EXTERNAL_TOOLS = new Set(["diff", "log", "show"]);
// Options that write files, run external programs, read outside the repository, or wait on stdin.
// --show-signature runs gpg/ssh-keygen on worker-written signatures.
const BANNED = ["--output", "--ext-diff", "--textconv", "--no-index", "--exec-path", "--upload-pack", "--stdin", "--show-signature"];
// Real options that happen to be a prefix of a banned one.
const EXACT_OK = new Set(["--text"]);

const ALLOWED = "Allowed: rev-parse, log, diff, show, status, worktree list, with the subcommand first (no global options).";

/** The git argv to run for a model-written `git_read` call, or why it is refused. */
export function validateGitReadArgs(args: string[]): { argv: string[] } | { error: string } {
  const [subcommand, ...rest] = args;
  if (!subcommand || !SUBCOMMANDS.has(subcommand)) return { error: `git_read refuses "${subcommand ?? ""}". ${ALLOWED}` };
  if (subcommand === "worktree" && rest[0] !== "list") return { error: `git_read only runs "worktree list". ${ALLOWED}` };
  for (const arg of rest) {
    if (arg === "-c") return { error: "git_read refuses -c." };
    // %G? and friends verify signatures, like --show-signature.
    if (arg.includes("%G")) return { error: "git_read refuses %G format placeholders: they run signature verification." };
    // `status -v` prints a diff, running textconv drivers.
    if (subcommand === "status" && (/^-[^-]*v/.test(arg) || (arg.length > 2 && "--verbose".startsWith(arg)))) {
      return { error: "git_read refuses status -v." };
    }
    if (arg.startsWith("--")) {
      // Git may accept an unambiguous abbreviation of a long option, so refuse prefixes too.
      const name = arg.split("=", 1)[0]!;
      if (name.length > 2 && !EXACT_OK.has(name) && BANNED.some((banned) => banned.startsWith(name))) {
        return { error: `git_read refuses ${name}: it could write files, run programs or read outside the repository.` };
      }
    } else if (!arg.startsWith("-") && (arg.startsWith("/") || arg.startsWith("~") || arg.split("/").includes(".."))) {
      // `git diff <path> <path>` with a path outside the work tree silently becomes `--no-index`.
      return { error: `git_read refuses path "${arg}": only paths inside the repository.` };
    }
  }
  if (!NO_EXTERNAL_TOOLS.has(subcommand)) return { argv: args };
  // --no-show-signature overrides log.showSignature; diff never verifies signatures.
  const noSignature = subcommand === "diff" ? [] : ["--no-show-signature"];
  return { argv: [subcommand, "--no-ext-diff", "--no-textconv", ...noSignature, ...rest] };
}

export function registerGitRead(pi: ExtensionAPI) {
  pi.registerTool({
    name: "git_read",
    label: "Git read",
    description:
      "Read-only git inspection of the Lead's repository, e.g. worker branches: rev-parse, log, diff, show, status, worktree list. Runs without confirmation, even after a worker report.",
    promptSnippet: "git_read: read-only git (rev-parse, log, diff, show, status, worktree list) in the Lead's repository",
    parameters: Type.Object({
      args: Type.Array(Type.String(), { description: 'git arguments, subcommand first, e.g. ["diff", "--stat", "main...pi-lead/x"]' }),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const checked = validateGitReadArgs(params.args);
      if ("error" in checked) throw new Error(checked.error);
      let stdout: string;
      try {
        ({ stdout } = await execFileAsync("git", checked.argv, {
          cwd: ctx.cwd,
          encoding: "utf8",
          maxBuffer: 16 << 20,
          timeout: 30_000,
          signal,
          // GIT_OPTIONAL_LOCKS=0: `status` must not refresh (write) the index.
          env: { ...process.env, GIT_PAGER: "cat", PAGER: "cat", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
        }));
      } catch (error) {
        const { stderr, message } = error as { stderr?: string; message: string };
        throw new Error(`git ${checked.argv.join(" ")} failed: ${stderr?.trim() || message}`);
      }
      const out = truncateHead(stdout);
      const text = out.truncated
        ? `${out.content}\n\n[output truncated: ${out.outputLines} of ${out.totalLines} lines; narrow the command]`
        : out.content || "(no output)";
      return { content: [{ type: "text", text }], details: undefined };
    },
  });
}
