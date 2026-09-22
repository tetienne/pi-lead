import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { pinReviewStandards } from "../src/review-context.ts";

test("pins repository constraints, security rules, and either ADR convention", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-lead-review-context-"));
  try {
    await Promise.all([
      mkdir(join(root, "docs", "adr"), { recursive: true }),
      mkdir(join(root, "docs", "decisions"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(root, "AGENTS.md"), "agent instructions\n"),
      writeFile(join(root, "CONSTRAINTS.md"), "repository constraints\n"),
      writeFile(join(root, "docs", "security-rules.md"), "security rules\n"),
      writeFile(join(root, "docs", "adr", "0001-package.md"), "package ADR\n"),
      writeFile(join(root, "docs", "decisions", "adr-0002-consumer.md"), "consumer ADR\n"),
    ]);

    const standards = await pinReviewStandards(root);

    assert.match(standards.contents, /--- CONSTRAINTS\.md ---\nrepository constraints/);
    assert.match(standards.contents, /--- docs\/security-rules\.md ---\nsecurity rules/);
    assert.match(standards.contents, /--- docs\/adr\/0001-package\.md ---\npackage ADR/);
    assert.match(standards.contents, /--- docs\/decisions\/adr-0002-consumer\.md ---\nconsumer ADR/);
    assert.match(standards.digest, /^[0-9a-f]{64}$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
