import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { test } from "node:test";

const RELEASE_SOURCE_FILES = [
  "src/chatgpt-input.ts",
  "src/chatgpt-launcher.ts",
  "src/chatgpt-policy.ts",
  "src/chatgpt-task.ts",
  "src/chatgpt-worker-host.ts",
  "src/controller-dispatch.ts",
  "src/debug-review-task.ts",
  "src/effective-route-observation.ts",
  "src/git-proposal.ts",
  "src/herdr-client.ts",
  "src/jev-intent-routing.ts",
  "src/lead.ts",
  "src/model-reasoning-routing.ts",
  "src/native-chatgpt-runtime.ts",
  "src/native-debug-review-runtime.ts",
  "src/native-proposed-change-runtime.ts",
  "src/native-review-fix-commit-runtime.ts",
  "src/native-task-journal.ts",
  "src/native-task-recovery.ts",
  "src/native-worker-observation.ts",
  "src/openrouter-jev-transport.ts",
  "src/planning-intake.ts",
  "src/policy.ts",
  "src/process-observation.ts",
  "src/proposed-change-input.ts",
  "src/proposed-change-launcher.ts",
  "src/proposed-change-policy.ts",
  "src/proposed-change-task.ts",
  "src/proposed-change-worker-host.ts",
  "src/review-context.ts",
  "src/review-fix-commit-task.ts",
  "src/state-files.ts",
  "src/task-recovery.ts",
  "src/tracker-intake.ts",
  "src/worker-toolchain-storage.ts",
] as const;

async function reachableSource(entrypoint: string): Promise<string[]> {
  const visited = new Set<string>();
  const visit = async (path: string): Promise<void> => {
    if (visited.has(path)) return;
    visited.add(path);
    const source = await readFile(path, "utf8");
    for (const match of source.matchAll(/["'`](\.\/[^"'`]+\.ts)["'`]/g)) {
      const dependency = normalize(join(dirname(path), match[1] ?? ""));
      if (dependency.startsWith("src/")) await visit(dependency);
    }
  };
  await visit(entrypoint);
  return [...visited].sort();
}

test("the release archive contains only the Lead and its internal adapters", async () => {
  const cache = await mkdtemp(join(tmpdir(), "pi-lead-npm-cache-"));
  let packed: Array<{ files: Array<{ path: string }> }>;
  try {
    packed = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, npm_config_cache: cache },
    })) as Array<{ files: Array<{ path: string }> }>;
  } finally {
    await rm(cache, { recursive: true, force: true });
  }
  const sourceFiles = packed[0]?.files
    .map((file) => file.path)
    .filter((path) => path.startsWith("src/"))
    .sort();

  assert.deepEqual(sourceFiles, [...RELEASE_SOURCE_FILES].sort());
  assert.deepEqual(sourceFiles, await reachableSource("src/lead.ts"));

  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
    scripts: Record<string, string>;
  };
  assert.equal(packageJson.scripts.fixture, "node src/run-fixture-cli.ts");
  assert.equal(packageJson.scripts["chatgpt-live"], "node src/run-chatgpt-live-cli.ts");
});
