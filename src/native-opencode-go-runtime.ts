import { createNativeChatGptRuntime } from "./native-chatgpt-runtime.ts";
import type { OpenCodeGoTaskRuntime } from "./opencode-go-task.ts";

export async function createNativeOpenCodeGoRuntime(
  options: Parameters<typeof createNativeChatGptRuntime>[0],
): Promise<OpenCodeGoTaskRuntime> {
  return (await createNativeChatGptRuntime({
    ...options,
    providerProfile: "opencode-go",
  })) as unknown as OpenCodeGoTaskRuntime;
}
