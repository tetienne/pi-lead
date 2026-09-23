/**
 * Build the Gondolin guest image PI Lead workers use.
 *
 *   npm run sandbox:image                 # Debian (glibc) + git + mise, tags pi-lead:latest
 *   npm run sandbox:image -- --alpine     # Gondolin's Alpine (musl) + git + mise, no Docker needed
 *   npm run sandbox:image -- --tag name:tag
 *
 * The default needs Docker or Podman: the root filesystem comes from
 * `sandbox/Dockerfile`. Alpine is lighter but many prebuilt mise tools are
 * glibc-only. Project toolchains are not baked in: PI Lead installs them per
 * project with `mise install` in a sandbox and caches them (see src/toolchains.ts).
 *
 * Then set `"sandbox": { "image": "pi-lead:latest" }` in ~/.pi/agent/pi-lead.json.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getDefaultBuildConfig } from "@earendil-works/gondolin";

const args = process.argv.slice(2);
const alpine = args.includes("--alpine");
const tagIndex = args.indexOf("--tag");
const tag = tagIndex >= 0 && args[tagIndex + 1] ? args[tagIndex + 1]! : "pi-lead:latest";

const run = (command: string, commandArgs: string[]) => {
  const result = spawnSync(command, commandArgs, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
};
const has = (command: string) => spawnSync(command, ["--version"], { stdio: "ignore" }).status === 0;

const config = getDefaultBuildConfig();
if (!config.alpine) throw new Error("expected Gondolin's default Alpine build configuration");

if (alpine) {
  config.alpine.rootfsPackages = [...new Set([...(config.alpine.rootfsPackages ?? []), "git", "mise"])];
} else {
  const runtime = has("docker") ? "docker" : has("podman") ? "podman" : undefined;
  if (!runtime) {
    console.error("Docker or Podman is required for the Debian image; use --alpine to build without one.");
    process.exit(1);
  }
  const platform = `linux/${config.arch === "aarch64" ? "arm64" : "amd64"}`;
  const rootfsImage = "pi-lead-rootfs:latest";
  run(runtime, ["build", "--platform", platform, "-t", rootfsImage, join(dirname(fileURLToPath(import.meta.url)))]);
  config.oci = { image: rootfsImage, runtime, platform, pullPolicy: "never" };
}

const path = join(mkdtempSync(join(tmpdir(), "pi-lead-image-")), "build-config.json");
writeFileSync(path, JSON.stringify(config, null, 2));
const cli = createRequire(import.meta.url)
  .resolve("@earendil-works/gondolin/package.json")
  .replace(/package\.json$/, "dist/bin/gondolin.js");
run(process.execPath, [cli, "build", "--config", path, "--tag", tag]);
