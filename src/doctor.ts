import type { Tier } from "./config.ts";
import type { WorkerRoute } from "./model-routing.ts";

/**
 * What the Lead checks about its setup: a warning at session start when
 * workers cannot run as intended, and `/lead-doctor` for the whole picture.
 * Pure formatting over facts gathered in lead.ts. `✓` fine, `!` needs a fix,
 * `-` optional and off.
 */

export type SetupFacts = {
  version: string;
  /** The Lead's Herdr workspace, or undefined outside Herdr. */
  herdr?: string;
  /** Herdr's Pi integration (`herdr integration install pi`) is installed. */
  herdrPi: boolean;
  jev: { configured: boolean; via: string; keyEnv: string; calls?: number; usd?: number; budgetUsd: number };
  tiers: Array<{ tier: Tier; route: Pick<WorkerRoute, "model" | "thinking"> | { error: string } }>;
  maxWorkers: number;
  verify?: string;
  /** A custom image selector from the config, or whether the released image is in Gondolin's store. */
  image: { custom: string } | { released: string; present: boolean };
};

/** One line per problem that stops workers or degrades them, for a warning at session start. */
export function startupWarnings(facts: Pick<SetupFacts, "herdr" | "herdrPi">): string[] {
  if (!facts.herdr) return ["PI Lead: this Pi is not inside Herdr, so it cannot start workers. Start it in a Herdr pane."];
  if (!facts.herdrPi) {
    return ["PI Lead: Herdr's Pi integration is missing (worker badges and messages to workers). Run `herdr integration install pi`."];
  }
  return [];
}

const routeLine = ({ tier, route }: SetupFacts["tiers"][number]) =>
  "error" in route ? `${tier} ! ${route.error}` : `${tier} → ${route.model} (${route.thinking})`;

/** What `/lead-doctor` prints. */
export function doctorReport(facts: SetupFacts): string {
  const herdr = !facts.herdr
    ? "! not inside Herdr: start this Pi in a Herdr pane to run workers"
    : facts.herdrPi
      ? `✓ workspace ${facts.herdr} · Pi integration installed`
      : `! workspace ${facts.herdr} · Pi integration missing: run \`herdr integration install pi\``;
  const jev = facts.jev.configured
    ? `✓ via ${facts.jev.via}` +
      (facts.jev.calls !== undefined && facts.jev.usd !== undefined
        ? ` · ${facts.jev.calls} calls · $${facts.jev.usd.toFixed(3)} of $${facts.jev.budgetUsd.toFixed(2)} today`
        : "")
    : `- no key in ${facts.jev.keyEnv}: documented defaults apply`;
  const image =
    "custom" in facts.image
      ? `✓ ${facts.image.custom} (from the config)`
      : facts.image.present
        ? `✓ ${facts.image.released}`
        : `- ${facts.image.released} downloads on the first delegate (a few hundred MB)`;
  const verify = facts.verify ? `✓ \`${facts.verify}\`` : "- none: results say unverified (set `verify` in pi-lead.json)";
  return [
    `PI Lead v${facts.version}`,
    `  herdr    ${herdr}`,
    `  jev      ${jev}`,
    `  image    ${image}`,
    `  verify   ${verify}`,
    `  workers  up to ${facts.maxWorkers} at once`,
    ...facts.tiers.map((entry, index) => `  ${index === 0 ? "tiers   " : "        "} ${routeLine(entry)}`),
  ].join("\n");
}
