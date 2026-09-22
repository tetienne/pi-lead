import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "pi-lead-package-acceptance-"));

try {
  const consumer = join(root, "consumer");
  const stage = join(root, "stage");
  const cache = join(root, "npm-cache");
  await Promise.all([mkdir(consumer), mkdir(stage), mkdir(cache)]);
  const environment = {
    ...process.env,
    PI_CODING_AGENT_DIR: join(root, "pi-state"),
    PI_OFFLINE: "1",
    npm_config_cache: cache,
  };
  const packed = JSON.parse(execFileSync(
    "npm",
    ["pack", "--json", "--pack-destination", root],
    { cwd: process.cwd(), env: environment, encoding: "utf8" },
  )) as Array<{ filename: string }>;
  const filename = packed[0]?.filename;
  assert.ok(filename, "npm pack must report its archive filename");
  const archive = join(root, filename);

  execFileSync(
    "npm",
    ["install", "--prefix", stage, "--ignore-scripts", "--omit=dev", archive],
    { cwd: consumer, env: environment, stdio: "pipe" },
  );
  const installedPackage = join(stage, "node_modules", "pi-lead");
  execFileSync("pi", ["install", "-l", "--approve", installedPackage], {
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
  const commands = response?.data?.commands?.filter(
    (command) => command.source === "extension" && command.sourceInfo?.path?.endsWith("/src/lead.ts"),
  );
  assert.deepEqual(commands?.map((command) => command.name), ["lead"]);
  process.stdout.write(`${JSON.stringify({ status: "DONE", archive: filename, commands: ["lead"] })}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
