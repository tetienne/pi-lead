/**
 * Files a worker branch can change that run on the host (or in CI) without
 * anyone reading them as code, or that widen PI Lead's own policy: hooks,
 * install scripts, package-manager and toolchain config, direnv, editor tasks,
 * CI workflows and the project's `.pi` folder. Ordinary source files also run
 * when the user tests them; these run implicitly, on checkout, install, `cd`
 * or commit. Agent instructions and skills (`AGENTS.md`, `CLAUDE.md`,
 * `.agents/`, `.claude/`) steer the next agent that works in the repository, and `.gitmodules` points
 * submodules at other code. Lockfiles are left out: judging them means parsing
 * registry URLs. The list is a hint to focus a review, not a security boundary.
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
  "**/AGENTS.md",
  "**/AGENTS.override.md",
  "**/CLAUDE.md",
  ".agents/**",
  ".claude/**",
  ".gitmodules",
];

/** Flagged only when a field that runs code changes (see `packageRunFieldsChanged`): dependency bumps alone stay quiet. */
export const PACKAGE_JSON = "**/package.json";

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

/** The `files` that `pattern` (one of `SENSITIVE_PATHS`) matches. */
export function filesMatching(pattern: string, files: readonly string[]): string[] {
  const regexps = MATCHERS.find((matcher) => matcher.pattern === pattern)?.regexps ?? [];
  return files.filter((file) => regexps.some((regexp) => regexp.test(file)));
}

/** `package.json` fields that run code: lifecycle scripts, and the package manager Corepack downloads and runs. */
const RUN_FIELDS = ["scripts", "packageManager"] as const;

/**
 * Whether a `package.json`'s `RUN_FIELDS` differ between two versions
 * (undefined: the file is absent on that side). A file added or removed, a
 * field present on one side only, or content that is not a JSON object all
 * count as changed.
 */
export function packageRunFieldsChanged(before: string | undefined, after: string | undefined): boolean {
  if (before === undefined || after === undefined) return true;
  try {
    const [a, b]: unknown[] = [JSON.parse(before), JSON.parse(after)];
    if (!isObject(a) || !isObject(b)) return true;
    return RUN_FIELDS.some((field) => !deepEqual(a[field], b[field]));
  } catch {
    return true;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]));
  }
  return a === b;
}

/**
 * The patterns (from the fixed list, never the worker-chosen file names) that
 * any of `files` matches, in list order. File names are repository-relative,
 * as `git diff --name-only` prints them.
 */
export function sensitivePatterns(files: readonly string[]): string[] {
  return MATCHERS.filter(({ regexps }) => files.some((file) => regexps.some((regexp) => regexp.test(file)))).map(({ pattern }) => pattern);
}
