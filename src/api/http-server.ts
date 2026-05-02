import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { appConfig } from "../config.js";
import { shutdownSupervisor } from "../process-supervisor.js";
import { CoreWrapper } from "../core/wrapper.js";
import { modelListResponse, openaiError, type ChatCompletionRequest } from "../core/response-validator.js";

const jsonHeaders = { "content-type": "application/json; charset=utf-8" } as const;
const MAX_REQUEST_ID_BYTES = 256;

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

const addLog = (entry: LogEntry): void => {
  logs.push(entry);
  if (logs.length > 1_000) logs.shift();
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
    res.setHeader("access-control-allow-headers", "authorization,content-type,x-request-id");
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
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= MAX_REQUEST_ID_BYTES) return value;
  return bytes.subarray(0, MAX_REQUEST_ID_BYTES).toString("utf8");
};

const handleChatCompletions = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
  if (!isAuthorized(req)) {
    sendJson(res, 401, openaiError("Invalid or missing API key", "authentication_error", 401).body);
    return;
  }

  let body: ChatCompletionRequest;
  try {
    body = (await readBody(req)) as ChatCompletionRequest;
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
        sendSse(res, { error: { message: streamResult.body.error.message, type: "claude_cli_error" } });
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
    const requestId = boundedRequestId(String(req.headers["x-request-id"] || randomUUID()));
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
    });
    void (async () => {
      if (applyCors(req, res)) return;
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, { ok: true, status: "healthy", service: "claude-openai-wrapper" });
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
        .finally(() => process.exit(signal === "SIGTERM" ? 0 : 130));
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  await new Promise<void>((resolve) => {
    server.listen(appConfig.httpPort, appConfig.httpHost, resolve);
  });
  console.log(`Claude OpenAI wrapper listening on http://${appConfig.httpHost}:${appConfig.httpPort}`);
  console.log("Endpoints: GET /health, GET /v1/models, POST /v1/chat/completions");
  if (!appConfig.apiKey) console.warn("Warning: CLAUDE_WRAPPER_API_KEY is not set; local API is unauthenticated.");
};
