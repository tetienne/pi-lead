/**
 * Files a worker branch can change that run on the host (or in CI) without
 * anyone reading them as code, or that widen PI Lead's own policy: hooks,
 * install scripts, package-manager and toolchain config, direnv, editor tasks,
 * CI workflows and the project's `.pi` folder. Ordinary source files also run
 * when the user tests them; these run implicitly, on checkout, install, `cd`
 * or commit. Lockfiles are left out: judging them means parsing registry URLs.
 *
 * `**` alone matches any path below; a leading `**` + `/` also matches
 * at any depth; `*` stays within one path segment. Matching ignores case (a
 * case-insensitive host file system resolves `.ENVRC` as `.envrc`), and a
 * changed path that is one of a pattern's parent directories matches too: it
 * is a file, symlink or submodule where that directory should be, so a symlink
 * such as `.vscode -> ide` cannot hide `ide/settings.json`.
 */
export const SENSITIVE_PATHS: readonly string[] = [
  ".github/workflows/**",
  ".github/actions/**",
  "**/package.json",
  "**/.npmrc",
  "**/.yarnrc*",
  "**/.pnpmfile.cjs",
  "**/.mise*.toml",
  "**/mise*.toml",
  "**/mise/config*.toml",
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
  return new RegExp(`^${source}$`, "i");
}

/** The pattern itself, then each parent directory it names (`a/b/**` → `a`, `a/b`); never a bare `**`. */
function patternRegExps(pattern: string): RegExp[] {
  const segments = pattern.split("/");
  const parents = segments
    .slice(0, -1)
    .map((_, i) => segments.slice(0, i + 1).join("/"))
    .filter((parent) => !/(^|\/)\*\*$/.test(parent));
  return [pattern, ...parents].map(patternRegExp);
}

const MATCHERS = SENSITIVE_PATHS.map((pattern) => ({ pattern, regexps: patternRegExps(pattern) }));

/**
 * The patterns (from the fixed list, never the guest-chosen file names) that
 * any of `files` matches, in list order. File names are repository-relative,
 * as `git diff --name-only` prints them.
 */
export function sensitivePatterns(files: readonly string[]): string[] {
  return MATCHERS.filter(({ regexps }) => files.some((file) => regexps.some((regexp) => regexp.test(file)))).map(({ pattern }) => pattern);
}
