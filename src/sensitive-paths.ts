/**
 * Files a worker branch can change that run on the host (or in CI) without
 * anyone reading them as code, or that widen PI Lead's own policy: hooks,
 * install scripts, package-manager and toolchain config, direnv, editor tasks,
 * CI workflows and the project's `.pi` folder. Ordinary source files also run
 * when the user tests them; these run implicitly, on checkout, install, `cd`
 * or commit. Lockfiles are left out: judging them means parsing registry URLs.
 *
 * `**` alone matches any path below; a leading `**` + `/` also matches
 * at any depth; `*` stays within one path segment.
 */
export const SENSITIVE_PATHS: readonly string[] = [
  ".github/workflows/**",
  ".github/actions/**",
  "**/package.json",
  "**/.npmrc",
  "**/.yarnrc*",
  "**/.pnpmfile.cjs",
  "**/.mise.toml",
  "**/mise.toml",
  "**/.mise/**",
  "**/.config/mise/**",
  "**/.tool-versions",
  "**/.envrc",
  ".pi/**",
  ".husky/**",
  ".githooks/**",
  "lefthook.yml",
  "lefthook.yaml",
  ".lefthook.yml",
  ".pre-commit-config.yaml",
  ".vscode/tasks.json",
  ".vscode/settings.json",
];

function patternRegExp(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (pattern.startsWith("**/", i)) {
      source += "(?:.*/)?";
      i += 2;
    } else if (pattern.startsWith("**", i)) {
      source += ".*";
      i += 1;
    } else if (char === "*") source += "[^/]*";
    else source += char.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

const MATCHERS = SENSITIVE_PATHS.map((pattern) => ({ pattern, regexp: patternRegExp(pattern) }));

/**
 * The patterns (from the fixed list, never the guest-chosen file names) that
 * any of `files` matches, in list order. File names are repository-relative,
 * as `git diff --name-only` prints them.
 */
export function sensitivePatterns(files: readonly string[]): string[] {
  return MATCHERS.filter(({ regexp }) => files.some((file) => regexp.test(file))).map(({ pattern }) => pattern);
}
