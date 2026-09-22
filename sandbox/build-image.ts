/**
 * Build the Gondolin guest image PI Lead workers use: Gondolin's default
 * Alpine image plus git (commits and reviews happen inside the VM).
 *
 *   npm run sandbox:image            # tags pi-lead:latest
 *   npm run sandbox:image -- <tag>
 *
 * Then set `"sandbox": { "image": "pi-lead:latest" }` in ~/.pi/agent/pi-lead.json.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getDefaultBuildConfig } from "@earendil-works/gondolin";

const EXTRA_PACKAGES = ["git"];
const tag = process.argv[2] ?? "pi-lead:latest";

const config = getDefaultBuildConfig();
if (!config.alpine) throw new Error("expected Gondolin's default Alpine build configuration");
config.alpine.rootfsPackages = [...new Set([...(config.alpine.rootfsPackages ?? []), ...EXTRA_PACKAGES])];

const path = join(mkdtempSync(join(tmpdir(), "pi-lead-image-")), "build-config.json");
writeFileSync(path, JSON.stringify(config, null, 2));

const cli = createRequire(import.meta.url).resolve("@earendil-works/gondolin/package.json").replace(/package\.json$/, "dist/bin/gondolin.js");
const result = spawnSync(process.execPath, [cli, "build", "--config", path, "--tag", tag], { stdio: "inherit" });
process.exit(result.status ?? 1);
