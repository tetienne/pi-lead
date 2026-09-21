import { runOpenCodeGoWorkerHost } from "./opencode-go-worker-host.ts";

const stateDirectory = process.argv[2];
if (!stateDirectory) throw new Error("OpenCode Go launcher requires a state directory");
await runOpenCodeGoWorkerHost({
  stateDirectory,
  overageConfirmedDisabled: process.env.PI_LEAD_OPENCODE_GO_NO_OVERAGE_CONFIRMED === "1",
  liveOutput: (line) => process.stdout.write(line),
});
