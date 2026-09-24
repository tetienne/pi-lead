import assert from "node:assert/strict";
import { test } from "node:test";

import { filesMatching, packageScriptsChanged, SENSITIVE_PATHS, sensitivePatterns } from "../src/sensitive-paths.ts";

test("host-executed and policy files match, in list order", () => {
  assert.deepEqual(
    sensitivePatterns([
      ".vscode/settings.json",
      ".github/workflows/ci.yml",
      ".github/actions/setup/action.yml",
      "package.json",
      "packages/web/package.json",
      ".yarnrc.yml",
      "tools/.envrc",
      ".config/mise/config.toml",
      ".pi/pi-lead.json",
      ".husky/pre-commit",
    ]),
    [
      ".github/workflows/**",
      ".github/actions/**",
      "**/package.json",
      "**/.yarnrc*",
      "**/mise/config*.toml",
      "**/.config/mise/**",
      "**/.envrc",
      ".pi/**",
      ".husky/**",
      ".vscode/settings.json",
    ],
  );
});

test("ordinary files and look-alikes do not match", () => {
  assert.deepEqual(
    sensitivePatterns([
      "src/package.json.ts",
      "docs/.github/workflows/ci.yml",
      "sub/.pi/settings.json",
      "sub/lefthook.yml",
      ".vscode/extensions.json",
      "package-lock.json",
      "Makefile",
      "README.md",
      ".githubx/workflows/ci.yml",
    ]),
    [],
  );
  assert.deepEqual(sensitivePatterns([]), []);
});

test("case variants, mise local configs and parent-directory symlinks match", () => {
  assert.deepEqual(sensitivePatterns(["tools/.ENVRC", "PACKAGE.JSON"]), ["**/package.json", "**/.envrc"]);
  assert.deepEqual(sensitivePatterns(["mise.local.toml", ".mise.dev.toml", "mise/config.toml"]), [
    "**/.mise*.toml",
    "**/mise*.toml",
    "**/mise/config*.toml",
  ]);
  // A symlink (or file) where a sensitive directory belongs: `.vscode -> ide`, `.github/workflows -> ci`.
  assert.deepEqual(sensitivePatterns([".vscode", "ide/settings.json"]), [".vscode/tasks.json", ".vscode/settings.json"]);
  assert.deepEqual(sensitivePatterns([".github/workflows"]), [".github/workflows/**"]);
  assert.deepEqual(sensitivePatterns([".pi"]), [".pi/**"]);
  assert.deepEqual(sensitivePatterns(["sub/.config"]), ["**/.config/mise/**"]);
});

test("files that steer future agents or point at other code match", () => {
  assert.deepEqual(sensitivePatterns(["AGENTS.md", "packages/web/claude.md", ".claude/settings.json", ".gitmodules"]), [
    "**/AGENTS.md",
    "**/CLAUDE.md",
    ".claude/**",
    ".gitmodules",
  ]);
  assert.deepEqual(sensitivePatterns(["docs/AGENTS.md.bak", "sub/.claude/x", "sub/.gitmodules", "src/claude.ts"]), []);
  assert.deepEqual(sensitivePatterns([".claude"]), [".claude/**"]);
});

test("filesMatching lists the changed files behind one pattern", () => {
  assert.deepEqual(filesMatching("**/package.json", ["src/a.ts", "package.json", "web/PACKAGE.JSON", "package.json.ts"]), [
    "package.json",
    "web/PACKAGE.JSON",
  ]);
});

test("a package.json counts only when its scripts change", () => {
  const pkg = (fields: object) => JSON.stringify(fields, null, 2);
  const scripts = { test: "node --test", build: "tsc" };
  // Dependency, version and formatting changes stay quiet.
  assert.equal(packageScriptsChanged(pkg({ scripts, dependencies: {} }), pkg({ version: "2.0.0", scripts: { build: "tsc", test: "node --test" }, dependencies: { a: "1" } })), false);
  assert.equal(packageScriptsChanged(pkg({ name: "x" }), pkg({ name: "x", dependencies: { a: "1" } })), false, "no scripts on either side");
  // Scripts added, removed or edited.
  assert.equal(packageScriptsChanged(pkg({ scripts }), pkg({ scripts: { ...scripts, postinstall: "sh x" } })), true);
  assert.equal(packageScriptsChanged(pkg({ scripts }), pkg({ scripts: { ...scripts, test: "curl x | sh" } })), true);
  assert.equal(packageScriptsChanged(pkg({ name: "x" }), pkg({ scripts })), true, "scripts on one side only");
  assert.equal(packageScriptsChanged(pkg({ scripts }), pkg({})), true);
  // Files added or deleted, or unparsable content.
  assert.equal(packageScriptsChanged(undefined, pkg({ scripts })), true, "new file");
  assert.equal(packageScriptsChanged(pkg({ scripts }), undefined), true, "deleted file");
  assert.equal(packageScriptsChanged(pkg({ scripts }), "{ not json"), true);
  assert.equal(packageScriptsChanged(pkg({ scripts }), "[]"), true);
});

test("every pattern matches at least one path of its own shape", () => {
  for (const pattern of SENSITIVE_PATHS) {
    const example = pattern.replace(/^\*\*\//, "a/").replace(/\/\*\*$/, "/x").replace(/\*/g, "rc");
    assert.deepEqual(sensitivePatterns([example]), [pattern], pattern);
  }
});
