import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { appConfig } from "../config.js";
import { shutdownSupervisor } from "../process-supervisor.js";
import { traceEvent } from "../trace.js";
import { CoreWrapper } from "../core/wrapper.js";
import { modelListResponse, openaiError, type ChatCompletionRequest } from "../openai-adapter.js";

const jsonHeaders = { "content-type": "application/json; charset=utf-8" } as const;
// 256 bytes is a reasonable upper bound for request IDs; longer values are likely corrupted or adversarial
const MAX_REQUEST_ID_BYTES = 256;
const MAX_LOG_ENTRIES = 1_000; // In-memory log ring buffer size
const CLAUDE_CLI_ERROR_TYPE = "claude_cli_error"; // Synthetic error type for OpenAI-compat error responses
// Explicit allowlist — avoids capturing arbitrary sensitive headers like authorization
const SESSION_DIAGNOSTIC_HEADER_ALLOWLIST = new Set([
  "x-session-affinity",
  "x-session-id",
  "x-conversation-id",
  "x-thread-id",
  "x-request-id",
  "x-openai-client-user-agent",
  "anthropic-client-user-agent",
]);

type LogEntry = {
  readonly timestamp: string;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly durationMs: number;
  readonly requestId: string;
};

const logs: LogEntry[] = [];
const wrapper = new CoreWrapper();

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

const pickString = (record: Record<string, unknown> | undefined, key: string): string | undefined => {
  const value = record?.[key];
  return typeof value === "string" && value ? value : undefined;
};

const headerString = (headers: IncomingMessage["headers"], key: string): string | undefined => {
  const value = headers[key];
  if (typeof value === "string") return value.trim() || undefined;
  if (Array.isArray(value)) return value.find((item) => item.trim())?.trim();
  return undefined;
};

// Session ID header precedence (highest to lowest priority):
// x-session-affinity (load balancer affinity) > x-session-id > x-conversation-id > x-thread-id
const sessionIdFromHeaders = (headers: IncomingMessage["headers"]): string | undefined =>
  headerString(headers, "x-session-affinity") || headerString(headers, "x-session-id") || headerString(headers, "x-conversation-id") || headerString(headers, "x-thread-id");

const withHeaderSessionFallback = (body: ChatCompletionRequest, headers: IncomingMessage["headers"]): ChatCompletionRequest => {
  if (body.session_id || body.claude?.sessionId) return body;
  const headerSessionId = sessionIdFromHeaders(headers);
  if (!headerSessionId) return body;
  traceEvent("http.chat_completion.header_session", { sessionId: headerSessionId, source: "header" }, "debug");
  return { ...body, session_id: headerSessionId };
};

const sessionDiagnosticsFor = (body: unknown, headers: IncomingMessage["headers"]): Record<string, unknown> => {
  const request = isRecord(body) ? body : undefined;
  const metadata = isRecord(request?.metadata) ? request.metadata : undefined;
  const claude = isRecord(request?.claude) ? request.claude : undefined;
  const sessionHeaders = Object.fromEntries(
    Object.entries(headers).filter(([key]) => SESSION_DIAGNOSTIC_HEADER_ALLOWLIST.has(key.toLowerCase())),
  );

  return {
    headers: sessionHeaders,
    bodyKeys: request ? Object.keys(request) : [],
    metadataKeys: metadata ? Object.keys(metadata) : [],
    claudeKeys: claude ? Object.keys(claude) : [],
    candidates: {
      header_x_session_affinity: headerString(headers, "x-session-affinity"),
      header_x_session_id: headerString(headers, "x-session-id"),
      header_x_conversation_id: headerString(headers, "x-conversation-id"),
      header_x_thread_id: headerString(headers, "x-thread-id"),
      session_id: pickString(request, "session_id"),
      conversation_id: pickString(request, "conversation_id"),
      thread_id: pickString(request, "thread_id"),
      chat_id: pickString(request, "chat_id"),
      request_id: pickString(request, "request_id"),
      user: pickString(request, "user"),
      metadata_session_id: pickString(metadata, "session_id"),
      metadata_conversation_id: pickString(metadata, "conversation_id"),
      metadata_thread_id: pickString(metadata, "thread_id"),
      metadata_chat_id: pickString(metadata, "chat_id"),
      claude_sessionId: pickString(claude, "sessionId"),
    },
    messageCount: Array.isArray(request?.messages) ? request.messages.length : undefined,
  };
};

const addLog = (entry: LogEntry): void => {
  logs.push(entry);
  if (logs.length > MAX_LOG_ENTRIES) logs.shift();
};

const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, jsonHeaders);
  res.end(JSON.stringify(body));
};

const applyCors = (req: IncomingMessage, res: ServerResponse): boolean => {
  const origin = req.headers.origin;
  const allowed = appConfig.corsOrigins;
  if (origin && (allowed.includes("*") || allowed.includes(origin))) {
    res.setHeader("access-control-allow-origin", allowed.includes("*") ? "*" : origin);
    res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    res.setHeader("access-control-allow-headers", "authorization,content-type,x-request-id,x-session-affinity,x-session-id,x-conversation-id,x-thread-id");
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
};

const sendSse = (res: ServerResponse, data: unknown): void => {
  res.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
};

const readBody = async (req: IncomingMessage): Promise<unknown> => {
  const length = Number(req.headers["content-length"] || 0);
  if (length > appConfig.maxRequestBytes) {
    throw openaiError(`Request body too large. Maximum size is ${appConfig.maxRequestBytes} bytes.`, "request_too_large", 413);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    total += buffer.byteLength;
    if (total > appConfig.maxRequestBytes) {
      throw openaiError(`Request body too large. Maximum size is ${appConfig.maxRequestBytes} bytes.`, "request_too_large", 413);
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
};

const isAuthorized = (req: IncomingMessage): boolean => {
  if (!appConfig.apiKey) return true;
  const header = req.headers.authorization;
  return header === `Bearer ${appConfig.apiKey}`;
};

const boundedRequestId = (value: string): string => {
  // Decode first, then truncate at character boundary to avoid splitting multibyte UTF-8 sequences
  return Buffer.from(value).toString("utf8").slice(0, MAX_REQUEST_ID_BYTES);
};

const handleChatCompletions = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
  if (!isAuthorized(req)) {
    sendJson(res, 401, openaiError("Invalid or missing API key", "authentication_error", 401).body);
    return;
  }

  let body: ChatCompletionRequest;
  try {
    body = (await readBody(req)) as ChatCompletionRequest;
    traceEvent("http.chat_completion.request_diagnostic", sessionDiagnosticsFor(body, req.headers), "debug");
    traceEvent("http.chat_completion.request_body", body, "trace");
    body = withHeaderSessionFallback(body, req.headers);
  } catch (error) {
    if (typeof error === "object" && error !== null && "status" in error && "body" in error) {
      const typed = error as ReturnType<typeof openaiError>;
      sendJson(res, typed.status, typed.body);
    } else {
      sendJson(res, 400, openaiError("Request body must be valid JSON").body);
    }
    return;
  }

  const controller = new AbortController();
  let completed = false;
  res.on("close", () => {
    if (!completed) controller.abort();
  });

  if (body.stream) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });

    const streamResult = await wrapper.executeChatCompletionStreaming(
      body,
      (chunk) => {
        if (!res.destroyed) sendSse(res, chunk);
      },
      { signal: controller.signal },
    );

    if (!streamResult.ok) {
      if (!res.destroyed) {
        sendSse(res, { error: { message: streamResult.body.error.message, type: CLAUDE_CLI_ERROR_TYPE } });
        completed = true;
        res.end();
      }
      return;
    }

    if (!res.destroyed) {
      sendSse(res, "[DONE]");
      completed = true;
      res.end();
    }
    return;
  }

  const result = await wrapper.executeChatCompletion(body, { signal: controller.signal });
  completed = true;
  sendJson(res, result.status, result.body);
};

export const startHttpServer = async (): Promise<void> => {
  const server = createServer((req, res) => {
    const started = Date.now();
    const requestId = boundedRequestId((headerString(req.headers, "x-request-id") ?? randomUUID()).slice(0, MAX_REQUEST_ID_BYTES));
    res.setHeader("x-request-id", requestId);
    res.on("finish", () => {
      addLog({
        timestamp: new Date().toISOString(),
        method: req.method || "GET",
        path: req.url || "/",
        status: res.statusCode,
        durationMs: Date.now() - started,
        requestId,
      });
      traceEvent(
        "http.request",
        {
          method: req.method || "GET",
          path: req.url || "/",
          status: res.statusCode,
          durationMs: Date.now() - started,
          requestId,
        },
        "info",
      );
    });
    void (async () => {
      if (applyCors(req, res)) return;
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, { ok: true, status: "healthy", service: "claude-openai" });
        return;
      }
      if (req.method === "GET" && url.pathname === "/logs") {
        if (!isAuthorized(req)) {
          sendJson(res, 401, openaiError("Invalid or missing API key", "authentication_error", 401).body);
          return;
        }
        const limit = Math.min(Number(url.searchParams.get("limit") || 100), 1_000);
        sendJson(res, 200, { logs: logs.slice(-limit), total: Math.min(logs.length, limit) });
        return;
      }
      if (req.method === "POST" && url.pathname === "/logs/clear") {
        if (!isAuthorized(req)) {
          sendJson(res, 401, openaiError("Invalid or missing API key", "authentication_error", 401).body);
          return;
        }
        logs.length = 0;
        sendJson(res, 200, { cleared: true });
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/models") {
        if (!isAuthorized(req)) sendJson(res, 401, openaiError("Invalid or missing API key", "authentication_error", 401).body);
        else sendJson(res, 200, modelListResponse());
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        await handleChatCompletions(req, res);
        return;
      }
      sendJson(res, 404, openaiError(`Unknown endpoint: ${url.pathname}`, "not_found_error", 404).body);
    })().catch((error: unknown) => {
      if (!res.headersSent) sendJson(res, 500, openaiError(error instanceof Error ? error.message : String(error), "server_error", 500).body);
      else res.end();
    });
  });

  const shutdown = (signal: NodeJS.Signals): void => {
    server.close(() => {
      shutdownSupervisor()
        .catch((error: unknown) => console.error(error instanceof Error ? error.stack ?? error.message : String(error)))
        // Exit code 130 = process terminated by SIGINT (Ctrl+C), following Unix convention
        .finally(() => process.exit(signal === "SIGTERM" ? 0 : 130));
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  await new Promise<void>((resolve) => {
    server.listen(appConfig.httpPort, appConfig.httpHost, resolve);
  });
  console.log(`Claude OpenAI listening on http://${appConfig.httpHost}:${appConfig.httpPort}`);
  console.log("Endpoints: GET /health, GET /v1/models, POST /v1/chat/completions");
  if (!appConfig.apiKey) console.warn("Warning: CLAUDE_OPENAI_API_KEY is not set; local API is unauthenticated.");
  traceEvent(
    "server.start",
    {
      host: appConfig.httpHost,
      port: appConfig.httpPort,
      backend: appConfig.backend,
      defaultModel: appConfig.defaultModel,
      hasApiKey: Boolean(appConfig.apiKey),
      allowedPermissionModes: appConfig.allowedPermissionModes,
      allowedWorkingDirectoryPrefixes: appConfig.allowedWorkingDirectoryPrefixes,
      maxConcurrentClaudeProcesses: appConfig.maxConcurrentClaudeProcesses,
      maxQueueSize: appConfig.maxQueueSize,
    },
    "info",
  );

  await new Promise<void>(() => {
    // Keep the foreground process alive until a shutdown signal is received.
  });
};
