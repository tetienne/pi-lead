import assert from "node:assert/strict";
import { test } from "node:test";

import { SENSITIVE_PATHS, sensitivePatterns } from "../src/sensitive-paths.ts";

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

test("mise local configs match; a pattern list, not an anti-evasion check", () => {
  assert.deepEqual(sensitivePatterns(["mise.local.toml", ".mise.dev.toml", "mise/config.toml"]), [
    "**/.mise*.toml",
    "**/mise*.toml",
    "**/mise/config*.toml",
  ]);
  // Neither case variants nor a path where a sensitive directory belongs (a symlinked parent) are chased.
  assert.deepEqual(sensitivePatterns(["tools/.ENVRC", "PACKAGE.JSON", ".vscode", ".github/workflows", ".pi"]), []);
});

test("files that steer future agents or point at other code match", () => {
  assert.deepEqual(sensitivePatterns(["AGENTS.md", "sub/AGENTS.override.md", "packages/web/CLAUDE.md", ".agents/skills/x/SKILL.md", ".claude/settings.json", ".gitmodules"]), [
    "**/AGENTS.md",
    "**/AGENTS.override.md",
    "**/CLAUDE.md",
    ".agents/**",
    ".claude/**",
    ".gitmodules",
  ]);
  assert.deepEqual(sensitivePatterns(["docs/AGENTS.md.bak", "sub/.claude/x", "sub/.gitmodules", "src/claude.ts"]), []);
});

test("every pattern matches at least one path of its own shape", () => {
  for (const pattern of SENSITIVE_PATHS) {
    const example = pattern.replace(/^\*\*\//, "a/").replace(/\/\*\*$/, "/x").replace(/\*/g, "rc");
    assert.deepEqual(sensitivePatterns([example]), [pattern], pattern);
  }
});
