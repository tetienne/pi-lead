import { createHttpHooks, type CreateHttpHooksResult } from "@earendil-works/gondolin";

export const CHATGPT_TOKEN_ENV = "PI_LEAD_CHATGPT_TOKEN";
export const CHATGPT_ACCOUNT_ENV = "PI_LEAD_CHATGPT_ACCOUNT_ID";
export const CHATGPT_HOST = "chatgpt.com";
export const CHATGPT_RESPONSES_PATH = "/backend-api/codex/responses";

export type ChatGptCredential = {
  accessToken: string;
  accountId: string;
};

export type ChatGptMediation = {
  allowedHosts: readonly [typeof CHATGPT_HOST];
  guestEnvironment: Readonly<Record<string, string>>;
  httpHooks: CreateHttpHooksResult["httpHooks"];
  providerOverlay: {
    providers: { "openai-codex": { apiKey: string } };
  };
  settings: {
    cacheWarming: "off";
    transport: "sse";
  };
  getLastPolicyRejection(): string | undefined;
  redactHostSecrets(value: string): string;
};

type ChatGptMediationOptions = {
  initialCredential: ChatGptCredential;
  refreshCredential(signal?: AbortSignal): Promise<ChatGptCredential>;
  placeholderNonce: string;
};

function requireCredential(credential: ChatGptCredential): void {
  if (!credential.accessToken.trim()) throw new Error("ChatGPT access token is empty");
  if (!credential.accountId.trim()) throw new Error("ChatGPT account ID is empty");
}

function encodeBase64Url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function createSyntheticCodexToken(accountId: string, nonce: string): string {
  const header = encodeBase64Url({ alg: "none", typ: "JWT" });
  const payload = encodeBase64Url({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  });
  return `${header}.${payload}.${encodeBase64Url({ nonce })}`;
}

function providerRequestViolation(
  request: Request,
  tokenPlaceholder: string,
  accountPlaceholder: string,
): string | undefined {
  const url = new URL(request.url);
  if (
    url.protocol !== "https:" ||
    url.hostname !== CHATGPT_HOST ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== CHATGPT_RESPONSES_PATH ||
    url.search !== "" ||
    url.hash !== "" ||
    request.method.toUpperCase() !== "POST"
  ) {
    return `destination or method outside policy (${request.method} ${url.toString()})`;
  }

  if (request.headers.get("authorization") !== `Bearer ${tokenPlaceholder}`) {
    const authorization = request.headers.get("authorization");
    return `synthetic bearer mismatch (present=${authorization !== null}, bearer=${authorization?.startsWith("Bearer ") === true}, length=${authorization?.length ?? 0}, expectedLength=${tokenPlaceholder.length + 7})`;
  }
  if (request.headers.get("chatgpt-account-id") !== accountPlaceholder) {
    return "missing synthetic account header";
  }
  if (request.headers.get("accept") !== "text/event-stream") return "transport is not SSE";
  if (request.headers.get("content-type") !== "application/json") {
    return `unexpected content type ${request.headers.get("content-type") ?? "missing"}`;
  }
  if (request.headers.get("openai-beta") !== "responses=experimental") {
    return `unexpected OpenAI-Beta header ${request.headers.get("openai-beta") ?? "missing"}`;
  }

  for (const [name, value] of request.headers) {
    if (name === "authorization" || name === "chatgpt-account-id") continue;
    if (value.includes(tokenPlaceholder) || value.includes(accountPlaceholder)) {
      return `synthetic credential appeared in disallowed header ${name}`;
    }
  }
  return undefined;
}

function credentialGuardedResponse(
  response: Response,
  sensitiveValues: ReadonlySet<string>,
  onViolation: () => void,
): Response {
  if (!response.body) return response;
  const secrets = [...sensitiveValues].map((value) => Buffer.from(value, "utf8"));
  const retainedTailBytes = Math.max(...secrets.map((secret) => secret.byteLength)) - 1;
  let pending = Buffer.alloc(0);
  const containsSecret = () => secrets.some((secret) => pending.indexOf(secret) >= 0);
  const fail = (controller: TransformStreamDefaultController<Uint8Array>) => {
    pending = Buffer.alloc(0);
    onViolation();
    controller.error(new Error("ChatGPT returned a credential-bearing response body"));
  };
  const guarded = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        pending = Buffer.concat([pending, Buffer.from(chunk)]);
        if (containsSecret()) {
          fail(controller);
          return;
        }
        const releasableBytes = pending.byteLength - retainedTailBytes;
        if (releasableBytes > 0) {
          controller.enqueue(pending.subarray(0, releasableBytes));
          pending = pending.subarray(releasableBytes);
        }
      },
      flush(controller) {
        if (containsSecret()) {
          fail(controller);
          return;
        }
        if (pending.byteLength > 0) controller.enqueue(pending);
      },
    }),
  );
  return new Response(guarded, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export function createChatGptMediation(options: ChatGptMediationOptions): ChatGptMediation {
  requireCredential(options.initialCredential);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(options.placeholderNonce)) {
    throw new Error("Invalid ChatGPT placeholder nonce");
  }

  const accountPlaceholder = `pi-lead-account-${options.placeholderNonce}`;
  const tokenPlaceholder = createSyntheticCodexToken(accountPlaceholder, options.placeholderNonce);
  const sensitiveValues = new Set([
    options.initialCredential.accessToken,
    options.initialCredential.accountId,
  ]);
  let currentCredential = options.initialCredential;
  let lastPolicyRejection: string | undefined;
  let hooksResult: CreateHttpHooksResult;
  hooksResult = createHttpHooks({
    allowedHosts: [CHATGPT_HOST],
    replaceSecretsInQuery: false,
    secrets: {
      [CHATGPT_TOKEN_ENV]: {
        hosts: [CHATGPT_HOST],
        placeholder: tokenPlaceholder,
        value: options.initialCredential.accessToken,
      },
      [CHATGPT_ACCOUNT_ENV]: {
        hosts: [CHATGPT_HOST],
        placeholder: accountPlaceholder,
        value: options.initialCredential.accountId,
      },
    },
    isRequestAllowed(request) {
      const placeholderViolation = providerRequestViolation(
        request,
        tokenPlaceholder,
        accountPlaceholder,
      );
      lastPolicyRejection = placeholderViolation
        ? providerRequestViolation(
            request,
            currentCredential.accessToken,
            currentCredential.accountId,
          )
        : undefined;
      return lastPolicyRejection === undefined;
    },
    async onRequest(request) {
      const violation = providerRequestViolation(request, tokenPlaceholder, accountPlaceholder);
      if (violation) {
        throw new Error(`ChatGPT request is outside policy: ${violation}`);
      }
      request.headers.set("accept-encoding", "identity");
      let credential: ChatGptCredential;
      try {
        credential = await options.refreshCredential(request.signal);
        requireCredential(credential);
      } catch (error) {
        throw new Error(
          `ChatGPT credential refresh failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      sensitiveValues.add(credential.accessToken);
      sensitiveValues.add(credential.accountId);
      currentCredential = credential;
      hooksResult.secretManager.updateSecret(CHATGPT_TOKEN_ENV, { value: credential.accessToken });
      hooksResult.secretManager.updateSecret(CHATGPT_ACCOUNT_ENV, { value: credential.accountId });
    },
    onResponse(response) {
      if (response.status >= 300 && response.status < 400) {
        return new Response("ChatGPT provider redirects are not allowed", { status: 502 });
      }
      for (const value of response.headers.values()) {
        for (const sensitiveValue of sensitiveValues) {
          if (value.includes(sensitiveValue)) {
            return new Response("ChatGPT returned a credential-bearing header", { status: 502 });
          }
        }
      }
      const contentEncoding = response.headers.get("content-encoding");
      if (contentEncoding && contentEncoding.toLowerCase() !== "identity") {
        return new Response("Compressed ChatGPT responses are not allowed", { status: 502 });
      }
      return credentialGuardedResponse(response, sensitiveValues, () => {
        lastPolicyRejection = "provider response attempted to reflect host credentials";
      });
    },
  });

  return {
    allowedHosts: [CHATGPT_HOST],
    guestEnvironment: Object.freeze({ ...hooksResult.env }),
    httpHooks: hooksResult.httpHooks,
    providerOverlay: {
      providers: { "openai-codex": { apiKey: `$${CHATGPT_TOKEN_ENV}` } },
    },
    settings: {
      cacheWarming: "off",
      transport: "sse",
    },
    getLastPolicyRejection() {
      return lastPolicyRejection;
    },
    redactHostSecrets(value) {
      let redacted = value;
      for (const sensitiveValue of sensitiveValues) {
        redacted = redacted.split(sensitiveValue).join("[REDACTED]");
      }
      return redacted;
    },
  };
}
