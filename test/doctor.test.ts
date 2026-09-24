import assert from "node:assert/strict";
import { test } from "node:test";

import { doctorReport, startupWarnings, type SetupFacts } from "../src/doctor.ts";

const facts = (overrides: Partial<SetupFacts> = {}): SetupFacts => ({
  version: "0.6.0",
  herdr: "w1",
  herdrPi: true,
  jev: { configured: true, via: "openrouter", keyEnv: "PI_LEAD_JEV_API_KEY", calls: 14, usd: 0.004, budgetUsd: 1 },
  tiers: [
    { tier: "fast", route: { model: "openai-codex/gpt-6-luna", thinking: "medium" } },
    { tier: "standard", route: { model: "openai-codex/gpt-6-sol", thinking: "high" } },
    { tier: "deep", route: { error: "no model available for tier deep" } },
  ],
  maxWorkers: 2,
  verify: "npm test",
  image: { released: "pi-lead:v0.6.0", present: true },
  ...overrides,
});

test("the session start warns only about what stops or degrades workers", () => {
  assert.deepEqual(startupWarnings(facts()), []);
  assert.deepEqual(startupWarnings(facts({ jev: { configured: false, via: "openrouter", keyEnv: "K", budgetUsd: 1 }, verify: undefined })), []);
  assert.match(startupWarnings(facts({ herdr: undefined }))[0]!, /not inside Herdr/);
  assert.match(startupWarnings(facts({ herdrPi: false }))[0]!, /herdr integration install pi/);
});

test("/lead-doctor shows every check, with the fix for what is missing", () => {
  assert.equal(
    doctorReport(facts()),
    [
      "PI Lead v0.6.0",
      "  herdr    ✓ workspace w1 · Pi integration installed",
      "  jev      ✓ via openrouter · 14 calls · $0.004 of $1.00 today",
      "  image    ✓ pi-lead:v0.6.0",
      "  verify   ✓ `npm test`",
      "  workers  up to 2 at once",
      "  tiers    fast → openai-codex/gpt-6-luna (medium)",
      "           standard → openai-codex/gpt-6-sol (high)",
      "           deep ! no model available for tier deep",
    ].join("\n"),
  );
  const missing = doctorReport(
    facts({
      herdr: undefined,
      jev: { configured: false, via: "openrouter", keyEnv: "PI_LEAD_JEV_API_KEY", budgetUsd: 1 },
      verify: undefined,
      image: { released: "pi-lead:v0.6.0", present: false },
    }),
  );
  assert.match(missing, /herdr {4}! not inside Herdr/);
  assert.match(missing, /jev {6}- no key in PI_LEAD_JEV_API_KEY: documented defaults apply/);
  assert.match(missing, /image {4}- pi-lead:v0\.6\.0 downloads on the first delegate/);
  assert.match(missing, /verify {3}- none/);
  assert.match(doctorReport(facts({ image: { custom: "my-image:1" } })), /image {4}✓ my-image:1 \(from the config\)/);
});
