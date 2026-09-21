import {
  runReadOnlyChatGptTask,
  type ChatGptRunSummary,
  type ChatGptTaskRequest,
  type ChatGptTaskRuntime,
  type ChatGptWorker,
} from "./chatgpt-task.ts";

export type OpenCodeGoTaskRequest = ChatGptTaskRequest;
export type OpenCodeGoRunSummary = ChatGptRunSummary;
export type OpenCodeGoLaunchRequest = Omit<Parameters<ChatGptTaskRuntime["launch"]>[0], "provider" | "transport" | "cacheWarming" | "allowedHosts" | "tabLabel"> & {
  provider: "opencode-go";
  allowedHosts: readonly ["opencode.ai"];
  tabLabel: "PI Lead · OpenCode Go read-only worker";
};
export type OpenCodeGoTaskRuntime = Omit<ChatGptTaskRuntime, "launch"> & {
  launch(request: OpenCodeGoLaunchRequest, signal?: AbortSignal): Promise<ChatGptWorker>;
};

/**
 * The lifecycle is provider-neutral; this adapter supplies the fixed native Go
 * launch profile and deliberately has no fallback provider branch.
 */
export function runReadOnlyOpenCodeGoTask(
  request: OpenCodeGoTaskRequest,
  runtime: OpenCodeGoTaskRuntime,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<OpenCodeGoRunSummary> {
  const lifecycle: ChatGptTaskRuntime = {
    ...runtime,
    launch(_request, signal) {
      return runtime.launch({
        ..._request,
        provider: "opencode-go",
        allowedHosts: ["opencode.ai"],
        tabLabel: "PI Lead · OpenCode Go read-only worker",
      }, signal);
    },
  };
  return runReadOnlyChatGptTask(request, lifecycle, options);
}
