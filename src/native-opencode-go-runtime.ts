import { createNativeChatGptRuntime } from "./native-chatgpt-runtime.ts";
import type { OpenCodeGoTaskRuntime } from "./opencode-go-task.ts";

export async function createNativeOpenCodeGoRuntime(
  options: Parameters<typeof createNativeChatGptRuntime>[0],
): Promise<OpenCodeGoTaskRuntime> {
  return (await createNativeChatGptRuntime({
    ...options,
    workerProfile: {
      provider: "opencode-go",
      allowedHost: "opencode.ai",
      launcherPath: "./opencode-go-launcher.ts",
      requireChatGptProtocol: false,
    },
  })) as unknown as OpenCodeGoTaskRuntime;
}
