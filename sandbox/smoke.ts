/**
 * Boot a real Gondolin VM through the worker's sandboxed tools and check the
 * isolation claims: minimal guest environment (no host secrets), clone
 * write-through, read-only toolchain cache, allowlisted egress allowed and
 * other egress refused, and grep/find running inside the guest.
 *
 *   npm run sandbox:smoke
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { VM } from "@earendil-works/gondolin";

import { DEFAULT_CONFIG } from "../src/config.ts";
import { createSandboxVm, GUEST_MISE_DIR, GUEST_WORKSPACE, guestEnv } from "../src/sandbox.ts";
import { createEgressPolicy } from "../src/worker/egress.ts";
import { registerSandboxTools } from "../src/worker/sandbox-tools.ts";

process.env.SUPER_SECRET_TOKEN = "sk-live-should-never-reach-guest";
const clone = mkdtempSync(join(tmpdir(), "smoke-clone-"));
const cache = mkdtempSync(join(tmpdir(), "smoke-mise-"));
const tools = new Map<string, any>();
const pi: any = { registerTool: (tool: any) => tools.set(tool.name, tool), on: () => {} };
const decisions: string[] = [];
const allowRequest = createEgressPolicy({
  allowedHosts: ["registry.npmjs.org"],
  task: "smoke",
  judge: { egress: async () => "deny" },
  log: (line) => decisions.push(line),
});
let started: Promise<{ vm: VM; shellPath: string; env: Record<string, string>; root: string }> | undefined;
const ensureVm = () =>
  (started ??= createSandboxVm({
    label: "pi-lead smoke",
    sandbox: { ...DEFAULT_CONFIG.sandbox, ...(process.env.PI_LEAD_IMAGE ? { image: process.env.PI_LEAD_IMAGE } : {}) },
    mounts: { [GUEST_WORKSPACE]: { host: clone }, [GUEST_MISE_DIR]: { host: cache, readonly: true } },
    allowRequest,
  }).then((vm) => ({ vm, shellPath: "/bin/bash", env: guestEnv(true), root: clone })));
registerSandboxTools(pi, clone, ensureVm);

const run = async (name: string, params: unknown) => {
  const result = await tools.get(name).execute("id", params, undefined, undefined, {});
  return result.content.map((part: { text: string }) => part.text).join("");
};
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
};

const t0 = Date.now();
const env = await run("bash", { command: "env; cat /proc/1/environ 2>/dev/null | tr '\\0' '\\n'" });
console.log(`boot + first exec: ${Date.now() - t0} ms`);
check("no host secret in the guest", !env.includes("sk-live"));
check("mise environment present", env.includes(`MISE_DATA_DIR=${GUEST_MISE_DIR}`));
await run("write", { path: "hello.txt", content: "from guest\n" });
check("clone write-through", readFileSync(join(clone, "hello.txt"), "utf8") === "from guest\n");
await run("bash", {
  command: [
    "mkdir -p src/deep node_modules/x",
    "printf 'one\\nneedle 1\\ntwo\\n' > src/a.ts",
    "printf 'needle deep\\n' > src/deep/b.spec.ts",
    "printf 'needle hidden\\n' > node_modules/x/c.ts",
    "ln -s .. src/loop",
    "head -c 300000 /dev/zero | tr '\\0' x > src/min.js; printf 'needle\\n' >> src/min.js",
  ].join(" && "),
});
const grepped = await run("grep", { pattern: "needle", glob: "*.ts", context: 1 });
check(
  "grep runs in the guest (context, glob, pruning, symlink loop)",
  grepped === "src/a.ts-1- one\nsrc/a.ts:2: needle 1\nsrc/a.ts-3- two\nsrc/deep/b.spec.ts:1: needle deep",
  JSON.stringify(grepped),
);
const longLine = await run("grep", { pattern: "x+needle", path: "src" });
check("grep truncates long guest lines", longLine.startsWith("min.js:1: xxx") && longLine.includes("Some lines truncated"), longLine.slice(-120));
await run("grep", { pattern: "$(touch /tmp/pwned)", literal: false });
await run("grep", { pattern: "-e x --include=$(touch /tmp/pwned)" });
const pwned = await run("bash", { command: "test -e /tmp/pwned && echo pwned || echo clean" });
check("grep pattern is not shell-interpreted", pwned.trim() === "clean", pwned.trim());
const found = await run("find", { pattern: "src/**/*.spec.ts" });
check("find runs in the guest", found === "src/deep/b.spec.ts", JSON.stringify(found));
const cacheWrite = await run("bash", { command: `touch ${GUEST_MISE_DIR}/poison 2>&1; echo exit=$?` });
check("toolchain cache is read-only", !cacheWrite.includes("exit=0"), cacheWrite.trim());
const npm = await run("bash", { command: "curl -s -o /dev/null -w '%{http_code}' https://registry.npmjs.org/" });
check("allowlisted egress", npm.trim() === "200", npm.trim());
const other = await run("bash", { command: "curl -s -o /dev/null -w '%{http_code}' https://example.com/" });
check("other egress refused", other.trim() !== "200", `${other.trim()} ${decisions.join("; ")}`);
const tooling = (await run("bash", { command: "command -v git mise || true" })).replace("(no output)", "");
console.log(`image tools: ${tooling.trim().replace(/\n/g, ", ") || "none (default image; run npm run sandbox:image)"}`);
await (await ensureVm()).vm.close();
