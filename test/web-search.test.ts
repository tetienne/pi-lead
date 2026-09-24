import assert from "node:assert/strict";
import { test } from "node:test";

import { isCodexModel, pickCodexModel, registerWebSearch, searchPayload, WEB_SEARCH_TOOL } from "../src/worker/web-search.ts";

const codex = { provider: "openai-codex", id: "gpt-6-sol", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api" };
const codexLuna = { ...codex, id: "gpt-6-luna" };
const openaiKey = { provider: "openai", id: "gpt-6-sol", api: "openai-responses", baseUrl: "https://api.openai.com/v1" };
const opencodeGo = { provider: "opencode-go", id: "gpt-6-sol", api: "openai-responses", baseUrl: "https://opencode.ai/zen/go/v1" };
const anthropic = { provider: "anthropic", id: "claude", api: "anthropic-messages", baseUrl: "https://api.anthropic.com" };

test("only Pi's openai-codex provider on chatgpt.com counts as Codex", () => {
  assert.ok(isCodexModel(codex));
  assert.ok(!isCodexModel(openaiKey), "an OpenAI API key is another bill");
  assert.ok(!isCodexModel(opencodeGo), "OpenCode Go serves GPT but is not Codex");
  assert.ok(!isCodexModel({ ...opencodeGo, provider: "openai-codex" }), "a Codex provider pointed at another host");
  assert.ok(!isCodexModel({ ...codex, baseUrl: "http://chatgpt.com/backend-api" }));
  assert.ok(!isCodexModel({ ...codex, api: "openai-responses" }));
  assert.ok(!isCodexModel(undefined));
});

test("the worker's own Codex model is preferred, else any Codex model with credentials, never another provider", () => {
  assert.equal(pickCodexModel(codexLuna, [codex, codexLuna]), codexLuna);
  assert.equal(pickCodexModel(anthropic, [anthropic, opencodeGo, codex]), codex);
  assert.equal(pickCodexModel(opencodeGo, [opencodeGo, openaiKey]), undefined);
});

test("the payload keeps Pi's request but forces one hosted web search", () => {
  const body = searchPayload(
    { model: "gpt-6-sol", instructions: "old", tools: [{ type: "function", name: "bash" }], tool_choice: "auto", reasoning: { effort: "none" }, store: false },
    ["nodejs.org"],
  );
  assert.equal(body.model, "gpt-6-sol");
  assert.equal(body.store, false);
  assert.deepEqual(body.tools, [{ type: "web_search", filters: { allowed_domains: ["nodejs.org"] } }]);
  assert.equal(body.tool_choice, "required");
  assert.equal(body.reasoning, undefined);
  assert.match(String(body.instructions), /primary sources/);
  assert.deepEqual(searchPayload({}, undefined).tools, [{ type: "web_search" }]);
});

function setup(options: { model?: unknown; available?: unknown[]; reply?: unknown; active?: string[] }) {
  const tools = new Map<string, any>();
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
  let active = options.active ?? ["bash", WEB_SEARCH_TOOL, "finish"];
  const calls: Array<{ model: any; context: any; payload: any }> = [];
  registerWebSearch({
    registerTool: (tool: any) => tools.set(tool.name, tool),
    on: (event: string, handler: any) => handlers.set(event, handler),
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => void (active = names),
  } as any);
  const ctx = {
    model: options.model,
    modelRegistry: {
      getAvailable: () => options.available ?? [],
      complete: async (model: any, context: any, requestOptions: any) => {
        const payload = await requestOptions.onPayload({ model: model.id, tools: [], tool_choice: "auto" }, model);
        calls.push({ model, context, payload });
        return options.reply ?? { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Node 24 is LTS ([nodejs.org](https://nodejs.org))." }] };
      },
    },
  };
  return { tool: tools.get(WEB_SEARCH_TOOL), handlers, ctx, calls, active: () => active };
}

test("web_search sends one Codex request and returns the answer as untrusted content", async () => {
  const { tool, ctx, calls } = setup({ model: anthropic, available: [anthropic, codex] });
  const result = await tool.execute("1", { query: " current node LTS ", domains: ["https://NodeJS.org/en", "bad domain"] }, undefined, undefined, ctx);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.model, codex);
  assert.equal(calls[0]!.context.messages[0].content, "current node LTS");
  assert.deepEqual(calls[0]!.payload.tools, [{ type: "web_search", filters: { allowed_domains: ["nodejs.org"] } }]);
  const text = result.content[0].text as string;
  assert.match(text, /^<web-search-results untrusted query="current node LTS">/);
  assert.match(text, /Node 24 is LTS/);
  assert.deepEqual(result.details, { provider: "openai-codex", model: "gpt-6-sol", domains: ["nodejs.org"] });
});

test("web_search refuses without Codex instead of falling back to another provider", async () => {
  const { tool, ctx, calls } = setup({ model: opencodeGo, available: [opencodeGo, openaiKey] });
  await assert.rejects(tool.execute("1", { query: "x" }, undefined, undefined, ctx), /openai-codex/);
  assert.equal(calls.length, 0);
});

test("a request whose model is not Codex at send time is refused", async () => {
  const { tool, ctx } = setup({ model: codex, available: [codex] });
  ctx.modelRegistry.complete = async (_model: any, _context: any, requestOptions: any) => requestOptions.onPayload({}, opencodeGo);
  await assert.rejects(tool.execute("1", { query: "x" }, undefined, undefined, ctx), /refused to send a request through opencode-go/);
});

test("provider errors and empty answers are reported as failures", async () => {
  const failed = setup({ model: codex, reply: { role: "assistant", stopReason: "error", errorMessage: "429 usage limit", content: [] } });
  await assert.rejects(failed.tool.execute("1", { query: "x" }, undefined, undefined, failed.ctx), /web_search failed: 429 usage limit/);
  const empty = setup({ model: codex, reply: { role: "assistant", stopReason: "stop", content: [] } });
  await assert.rejects(empty.tool.execute("1", { query: "x" }, undefined, undefined, empty.ctx), /no answer/);
  await assert.rejects(empty.tool.execute("1", { query: "  " }, undefined, undefined, empty.ctx), /non-empty query/);
});

test("the tool is hidden from the model when no Codex login exists", async () => {
  const without = setup({ model: anthropic, available: [anthropic] });
  await without.handlers.get("session_start")!({}, without.ctx);
  assert.deepEqual(without.active(), ["bash", "finish"]);
  const withCodex = setup({ model: anthropic, available: [anthropic, codex] });
  await withCodex.handlers.get("session_start")!({}, withCodex.ctx);
  assert.deepEqual(withCodex.active(), ["bash", WEB_SEARCH_TOOL, "finish"]);
});
