import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";

import {
  createReadonlyToolchainSeed,
  prepareToolchainCache,
} from "../src/toolchain-cache.ts";

test("a compatible trusted mise seed is reusable but remains read-only to every worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-lead-toolchain-cache-"));
  const first = await prepareToolchainCache({
    root,
    workerId: "worker-one",
    miseConfig: '[tools]\nnode = "24.14.1"\n',
    miseVersion: "2025.8.20-r0",
    guestArchitecture: "arm64",
  });

  assert.equal(first.state, "COLD");
  assert.equal(first.guest.seedDirectory, "/opt/pi-lead/mise-seed");
  assert.match(first.host.seedDirectory, /linux-arm64-musl/);
  assert.match(first.environment.MISE_DATA_DIR, /pi-lead-worker-one\/mise\/data$/);
  assert.equal(first.environment.MISE_DATA_DIR.includes(first.host.seedDirectory), false);

  await mkdir(join(first.host.seedDirectory, "data", "installs"), { recursive: true });
  await writeFile(join(first.host.seedDirectory, "data", "installs", "node"), "trusted seed");

  const second = await prepareToolchainCache({
    root,
    workerId: "worker-two",
    miseConfig: '[tools]\nnode = "24.14.1"\n',
    miseVersion: "2025.8.20-r0",
    guestArchitecture: "arm64",
  });
  assert.equal(second.state, "WARM");
  assert.equal(second.host.seedDirectory, first.host.seedDirectory);
  assert.notEqual(second.environment.MISE_DATA_DIR, first.environment.MISE_DATA_DIR);

  const seed = createReadonlyToolchainSeed(second);
  if (!seed.writeFile || !seed.readFile) throw new Error("Toolchain seed provider is incomplete");
  await assert.rejects(seed.writeFile("data/installs/node", "poisoned"));
  assert.equal(await seed.readFile("data/installs/node", "utf8"), "trusted seed");
});

test("toolchain seeds never cross guest architecture, ABI, mise version, or configuration boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-lead-toolchain-cache-"));
  const baseline = await prepareToolchainCache({
    root,
    workerId: "worker-one",
    miseConfig: '[tools]\nnode = "24.14.1"\n',
    miseVersion: "2025.8.20-r0",
    guestArchitecture: "x64",
  });

  const incompatible = await Promise.all([
    prepareToolchainCache({
      root,
      workerId: "worker-two",
      miseConfig: '[tools]\nnode = "24.14.1"\n',
      miseVersion: "2025.8.20-r0",
      guestArchitecture: "arm64",
    }),
    prepareToolchainCache({
      root,
      workerId: "worker-three",
      miseConfig: '[tools]\nnode = "24.14.1"\n',
      miseVersion: "2025.9.0-r0",
      guestArchitecture: "x64",
    }),
    prepareToolchainCache({
      root,
      workerId: "worker-four",
      miseConfig: '[tools]\nnode = "24.15.0"\n',
      miseVersion: "2025.8.20-r0",
      guestArchitecture: "x64",
    }),
  ]);

  for (const plan of incompatible) {
    assert.notEqual(plan.host.seedDirectory, baseline.host.seedDirectory);
    assert.equal(plan.state, "COLD");
  }
});

test("a cache plan rejects an unapproved worker identity or guest architecture", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-lead-toolchain-cache-"));
  await assert.rejects(
    prepareToolchainCache({
      root,
      workerId: "worker/escape",
      miseConfig: "",
      miseVersion: "2025.8.20-r0",
      guestArchitecture: "arm64",
    }),
    /worker ID/i,
  );
  await assert.rejects(
    prepareToolchainCache({
      root,
      workerId: "worker-one",
      miseConfig: "",
      miseVersion: "2025.8.20-r0",
      guestArchitecture: "riscv64",
    }),
    /architecture/i,
  );
});
