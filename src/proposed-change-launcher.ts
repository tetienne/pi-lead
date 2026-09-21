import { runProposedChangeWorkerHost } from "./proposed-change-worker-host.ts";

const stateDirectory = process.argv[2];
if (!stateDirectory) throw new Error("Proposed-change launcher requires a state directory");

await runProposedChangeWorkerHost({
  stateDirectory,
  liveOutput(message) {
    process.stdout.write(message);
  },
});
