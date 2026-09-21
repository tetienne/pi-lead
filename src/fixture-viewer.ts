import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { readJsonIfPresent } from "./state-files.ts";

const stateDirectory = process.argv[2];
if (!stateDirectory) throw new Error("Fixture viewer requires a state directory");

const logPath = join(stateDirectory, "runtime.log");
let bytesDisplayed = 0;

async function displayNewLogBytes(): Promise<void> {
  try {
    const log = await readFile(logPath);
    if (log.length > bytesDisplayed) {
      process.stdout.write(log.subarray(bytesDisplayed));
      bytesDisplayed = log.length;
    }
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
  }
}

while (true) {
  await displayNewLogBytes();
  if ((await readJsonIfPresent(join(stateDirectory, "termination.json"))) !== undefined) break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}
await displayNewLogBytes();
