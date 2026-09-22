/**
 * Boot a real Gondolin VM through the worker's sandboxed tools and check the
 * isolation claims: minimal guest environment (no host secrets), clone
 * write-through, allowlisted egress allowed, other egress refused.
 *
 *   npm run sandbox:smoke
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHttpHooks, RealFSProvider, VM } from "@earendil-works/gondolin";
import { createEgressPolicy } from "../src/worker/egress.ts";
import { GUEST_WORKSPACE, registerSandboxTools } from "../src/worker/sandbox-tools.ts";

process.env.SUPER_SECRET_TOKEN = "sk-live-should-never-reach-guest";
const clone = mkdtempSync(join(tmpdir(), "smoke-clone-"));
const tools = new Map<string, any>();
const pi: any = { registerTool: (t: any) => tools.set(t.name, t), on: () => {} };
const decisions: string[] = [];
const allow = createEgressPolicy({
  allowedHosts: ["registry.npmjs.org"], task: "smoke",
  judge: { egress: async () => "deny" }, log: (l) => decisions.push(l),
});
const { httpHooks } = createHttpHooks({ allowedHosts: ["*"], blockInternalRanges: true,
  isRequestAllowed: (r) => allow({ method: r.method, url: r.url }) });
let vmP: Promise<any> | undefined;
const ensureVm = () => (vmP ??= (async () => {
  const vm = await VM.create({ httpHooks, allowWebSockets: false, startTimeoutMs: 600_000,
    vfs: { mounts: { [GUEST_WORKSPACE]: new RealFSProvider(clone) } } });
  return { vm, shellPath: "/bin/bash" };
})());
registerSandboxTools(pi, clone, ensureVm);
const run = async (name: string, params: any) => {
  const r = await tools.get(name).execute("id", params, undefined, undefined, {});
  return r.content.map((c: any) => c.text).join("");
};
const t0 = Date.now();
console.log("env:", (await run("bash", { command: "env | sort" })).replace(/\n/g, " | "));
console.log("boot+first exec ms:", Date.now() - t0);
await run("write", { path: "hello.txt", content: "from guest\n" });
console.log("host sees:", JSON.stringify(readFileSync(join(clone, "hello.txt"), "utf8")));
console.log("uname:", await run("bash", { command: "uname -a; id -u; ls /workspace" }));
console.log("npm:", (await run("bash", { command: "curl -s -o /dev/null -w '%{http_code}' https://registry.npmjs.org/ || echo FAIL" })));
console.log("evil:", (await run("bash", { command: "curl -s -o /dev/null -w '%{http_code}' https://example.com/ ; echo \" exit=$?\"" })));
console.log("decisions:", decisions);
console.log("secret leaked:", (await run("bash", { command: "env; cat /proc/1/environ 2>/dev/null | tr '\\0' '\\n'" })).includes("sk-live"));
await (await ensureVm()).vm.close();
