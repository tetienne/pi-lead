import assert from "node:assert/strict";
import { test } from "node:test";

import type { EgressDecision } from "../src/jev.ts";
import { createEgressPolicy, hostMatches } from "../src/worker/egress.ts";

const judgeSaying = (decision: EgressDecision, calls: string[] = []) => ({
  egress: async ({ url }: { url: string }) => {
    calls.push(url);
    return decision;
  },
});

test("host patterns match exact hosts and subdomain wildcards", () => {
  assert.ok(hostMatches("registry.npmjs.org", ["registry.npmjs.org"]));
  assert.ok(hostMatches("registry.npmjs.org:443", ["registry.npmjs.org"]));
  assert.ok(hostMatches("a.b.example.com", ["*.example.com"]));
  assert.ok(!hostMatches("example.com.evil.io", ["*.example.com"]));
  assert.ok(!hostMatches("evil.io", ["registry.npmjs.org"]));
});

test("allowlisted hosts never reach Jev", async () => {
  const calls: string[] = [];
  const allow = createEgressPolicy({ allowedHosts: ["pypi.org"], task: "t", judge: judgeSaying("deny", calls) });
  assert.equal(await allow({ method: "GET", url: "https://pypi.org/simple/x" }), true);
  assert.equal(calls.length, 0);
});

test("Jev allows or denies unknown hosts; non-HTTP is refused", async () => {
  assert.equal(await createEgressPolicy({ allowedHosts: [], task: "t", judge: judgeSaying("allow") })({ method: "GET", url: "https://docs.rs" }), true);
  assert.equal(await createEgressPolicy({ allowedHosts: [], task: "t", judge: judgeSaying("deny") })({ method: "GET", url: "https://docs.rs" }), false);
  assert.equal(await createEgressPolicy({ allowedHosts: ["*"], task: "t", judge: judgeSaying("allow") })({ method: "GET", url: "ftp://x" }), false);
});

test("unsure requests go to the human, once per method and host", async () => {
  const questions: string[] = [];
  const allow = createEgressPolicy({
    allowedHosts: [],
    task: "t",
    judge: judgeSaying("ask"),
    askHuman: async (question) => {
      questions.push(question);
      return true;
    },
  });
  assert.equal(await allow({ method: "POST", url: "https://api.example.com/a" }), true);
  assert.equal(await allow({ method: "POST", url: "https://api.example.com/b" }), true);
  assert.deepEqual(questions, ["Allow the sandbox to POST api.example.com?"]);
});

test("without a human, unsure requests are denied", async () => {
  const allow = createEgressPolicy({ allowedHosts: [], task: "t", judge: judgeSaying("ask") });
  assert.equal(await allow({ method: "GET", url: "https://unknown.example" }), false);
});

test("allowlisted hosts are trusted for downloads only", async () => {
  const calls: string[] = [];
  const allow = createEgressPolicy({ allowedHosts: ["github.com"], task: "t", judge: judgeSaying("deny", calls) });
  assert.equal(await allow({ method: "GET", url: "https://github.com/org/repo/archive/main.tar.gz" }), true);
  assert.equal(await allow({ method: "POST", url: "https://github.com/org/repo.git/git-upload-pack" }), true, "git fetch");
  assert.equal(await allow({ method: "POST", url: "https://github.com/attacker/x.git/git-receive-pack" }), false, "git push is judged");
  assert.deepEqual(calls, ["https://github.com/attacker/x.git/git-receive-pack"]);
});

test("Jev decisions are not stretched to the whole host", async () => {
  const calls: string[] = [];
  const allow = createEgressPolicy({ allowedHosts: [], task: "t", judge: judgeSaying("allow", calls) });
  await allow({ method: "GET", url: "https://docs.rs/a" });
  await allow({ method: "GET", url: "https://docs.rs/b" });
  assert.equal(calls.length, 2);
});
