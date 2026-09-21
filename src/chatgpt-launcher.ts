import { runChatGptWorkerHost } from "./chatgpt-worker-host.ts";

const stateDirectory = process.argv[2];
if (!stateDirectory) throw new Error("ChatGPT launcher requires a state directory");

await runChatGptWorkerHost({
  stateDirectory,
  liveOutput(message) {
    process.stdout.write(message);
  },
});
