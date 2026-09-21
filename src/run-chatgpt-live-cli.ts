import { randomUUID } from "node:crypto";

import { prepareChatGptQuestion } from "./chatgpt-input.ts";
import { runReadOnlyChatGptTask } from "./chatgpt-task.ts";
import { createNativeChatGptRuntime } from "./native-chatgpt-runtime.ts";

const cwd = process.cwd();
const request = {
  taskId: randomUUID(),
  assignmentId: randomUUID(),
  question: await prepareChatGptQuestion(
    "--input CONTEXT.md -- In one sentence, explain what the term Lead means.",
    cwd,
  ),
};
const runtime = await createNativeChatGptRuntime({ cwd });
const summary = await runReadOnlyChatGptTask(request, runtime, { timeoutMs: 180_000 });

process.stdout.write(`${JSON.stringify(summary)}\n`);
if (summary.status !== "DONE") process.exitCode = 1;
