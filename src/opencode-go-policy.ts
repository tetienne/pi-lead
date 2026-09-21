import { createHttpHooks, type CreateHttpHooksResult } from "@earendil-works/gondolin";

export const OPENCODE_GO_API_KEY_ENV = "OPENCODE_API_KEY";
export const OPENCODE_GO_HOST = "opencode.ai";
export const OPENCODE_GO_RESPONSES_PATH = "/zen/go/v1/responses";

export type OpenCodeGoMediation = {
  allowedHosts: readonly ["opencode.ai"];
  guestEnvironment: Readonly<Record<string, string>>;
  httpHooks: CreateHttpHooksResult["httpHooks"];
  getLastPolicyRejection(): string | undefined;
  redactHostSecrets(value: string): string;
};

function requestViolation(
  request: Request,
  placeholder: string,
  apiKey: string,
  sessionId: string,
): string | undefined {
  const url = new URL(request.url);
  if (
    url.protocol !== "https:" || url.hostname !== OPENCODE_GO_HOST || url.port !== "" ||
    url.username !== "" || url.password !== "" || url.pathname !== OPENCODE_GO_RESPONSES_PATH ||
    url.search !== "" || url.hash !== "" || request.method.toUpperCase() !== "POST"
  ) return `destination or method outside policy (${request.method} ${url.toString()})`;
  const authorization = request.headers.get("authorization");
  if (authorization !== `Bearer ${placeholder}` && authorization !== `Bearer ${apiKey}`) {
    return "synthetic bearer mismatch";
  }
  if (request.headers.get("x-opencode-session") !== sessionId) return "missing native OpenCode session header";
  if (request.headers.get("x-opencode-client") !== "pi") return "missing native OpenCode client header";
  for (const [name, value] of request.headers) {
    if (name !== "authorization" && value.includes(placeholder)) {
      return `synthetic credential appeared in disallowed header ${name}`;
    }
  }
  return undefined;
}

function credentialGuardedResponse(response: Response, apiKey: string, reject: (detail: string) => void): Response {
  if (!response.body) return response;
  const secret = Buffer.from(apiKey, "utf8");
  let pending = Buffer.alloc(0);
  const guarded = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      pending = Buffer.concat([pending, Buffer.from(chunk)]);
      if (pending.includes(secret)) {
        pending = Buffer.alloc(0); reject("OpenCode Go provider attempted to reflect the host key");
        controller.error(new Error("OpenCode Go provider returned a credential-bearing response body")); return;
      }
      const releasable = pending.byteLength - secret.byteLength + 1;
      if (releasable > 0) { controller.enqueue(pending.subarray(0, releasable)); pending = pending.subarray(releasable); }
    },
    flush(controller) {
      if (pending.includes(secret)) { reject("OpenCode Go provider attempted to reflect the host key"); controller.error(new Error("OpenCode Go provider returned a credential-bearing response body")); return; }
      if (pending.byteLength > 0) controller.enqueue(pending);
    },
  }));
  return new Response(guarded, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export function createOpenCodeGoMediation(options: {
  apiKey: string;
  sessionId: string;
  placeholderNonce: string;
}): OpenCodeGoMediation {
  if (!options.apiKey.trim()) throw new Error("OpenCode Go API key is empty");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(options.placeholderNonce)) {
    throw new Error("Invalid OpenCode Go placeholder nonce");
  }
  if (!/^[A-Za-z0-9-]{1,160}$/.test(options.sessionId)) {
    throw new Error("Invalid OpenCode Go session identity");
  }
  const placeholder = `pi-lead-opencode-go-${options.placeholderNonce}`;
  let firstPolicyRejection: string | undefined;
  const reject = (detail: string) => { firstPolicyRejection ??= detail; };
  const hooks = createHttpHooks({
    allowedHosts: [OPENCODE_GO_HOST],
    replaceSecretsInQuery: false,
    secrets: {
      [OPENCODE_GO_API_KEY_ENV]: {
        hosts: [OPENCODE_GO_HOST],
        placeholder,
        value: options.apiKey,
      },
    },
    isRequestAllowed(request) {
      const violation = requestViolation(request, placeholder, options.apiKey, options.sessionId);
      if (violation) reject(violation);
      return violation === undefined;
    },
    onResponse(response) {
      if (response.status >= 300 && response.status < 400) {
        reject("OpenCode Go provider redirects are not allowed");
        return new Response("OpenCode Go provider redirects are not allowed", { status: 502 });
      }
      for (const value of response.headers.values()) {
        if (value.includes(options.apiKey)) {
          reject("OpenCode Go provider returned a credential-bearing header");
          return new Response("OpenCode Go provider returned a credential-bearing header", { status: 502 });
        }
      }
      return credentialGuardedResponse(response, options.apiKey, reject);
    },
  });
  return {
    allowedHosts: [OPENCODE_GO_HOST],
    guestEnvironment: Object.freeze({ ...hooks.env }),
    httpHooks: hooks.httpHooks,
    getLastPolicyRejection: () => firstPolicyRejection,
    redactHostSecrets(value) { return value.split(options.apiKey).join("[REDACTED]"); },
  };
}

export function classifyOpenCodeGoFailure(message: string): "QUOTA_EXHAUSTED" | "MODEL_UNAVAILABLE" | undefined {
  if (/usage limit|quota|allowance|included|balance|billing|insufficient/i.test(message)) {
    return "QUOTA_EXHAUSTED";
  }
  if (/model.+(?:unavailable|not found|unknown|does not exist)|no models available/i.test(message)) {
    return "MODEL_UNAVAILABLE";
  }
  return undefined;
}
