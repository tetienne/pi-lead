import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
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
  "src/dependency-request-policy.ts",
  "src/debug-review-task.ts",
  "src/effective-route-observation.ts",
  "src/git-proposal.ts",
  "src/herdr-client.ts",
  "src/jev-intent-routing.ts",
  "src/lead.ts",
  "src/model-reasoning-routing.ts",
  "src/mise-environment.ts",
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
  assert.equal(packageJson.scripts["package-acceptance"], "node src/run-package-acceptance-cli.ts");
});

test("a fresh consuming project activates the staged release archive and discovers only /lead", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-lead-consumer-"));
  try {
    const consumer = join(root, "consumer");
    await mkdir(consumer);
    const cache = join(root, "npm-cache");
    await mkdir(cache);
    const environment = {
      ...process.env,
      PI_CODING_AGENT_DIR: join(root, "pi-state"),
      PI_OFFLINE: "1",
      npm_config_cache: cache,
    };
    const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", root], {
      cwd: process.cwd(),
      env: environment,
      encoding: "utf8",
    })) as Array<{ filename: string }>;
    const filename = packed[0]?.filename;
    assert.ok(filename, "npm pack must report its archive filename");
    execFileSync("tar", ["-xzf", join(root, filename), "-C", root], { stdio: "pipe" });
    // Dependency installation is npm's responsibility. Reuse this checkout's
    // installed dependency tree here so the test stays deterministic/offline
    // while Pi loads the exact files staged in the release archive.
    await symlink(join(process.cwd(), "node_modules"), join(root, "package", "node_modules"), "dir");

    execFileSync("pi", ["install", "-l", "--approve", join(root, "package")], {
      cwd: consumer,
      env: environment,
      stdio: "pipe",
    });
    const output = execFileSync(
      "pi",
      ["--mode", "rpc", "--offline", "--no-session", "--no-tools", "--approve"],
      {
        cwd: consumer,
        env: environment,
        encoding: "utf8",
        input: `${JSON.stringify({ id: "commands", type: "get_commands" })}\n`,
      },
    );
    const response = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as {
        id?: string;
        data?: { commands?: Array<{ name: string; source: string; sourceInfo?: { path?: string } }> };
      })
      .find((entry) => entry.id === "commands");
    const piLeadCommands = response?.data?.commands?.filter(
      (command) => command.source === "extension" && command.sourceInfo?.path?.endsWith("/src/lead.ts"),
    );
    assert.deepEqual(piLeadCommands?.map((command) => command.name), ["lead"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
