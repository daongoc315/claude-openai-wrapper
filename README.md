# claude-openai-wrapper

[![CI](https://github.com/daongoc315/claude-openai-wrapper/actions/workflows/ci.yml/badge.svg)](https://github.com/daongoc315/claude-openai-wrapper/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/claude-openai-wrapper.svg)](https://www.npmjs.com/package/claude-openai-wrapper)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Alpha-stage local OpenAI-compatible HTTP/SSE wrapper around Claude Code. The default backend uses `@anthropic-ai/claude-agent-sdk`; the older direct CLI backend is available as a fallback.

Architecture mirrors `claude-wrapper` layering: API routes → core wrapper → Claude client → Agent SDK backend or supervised Claude CLI fallback.

## Purpose

`claude-openai-wrapper` lets local tools that speak the OpenAI Chat Completions API use Claude Code through a small local server.

It exposes OpenAI-style endpoints while keeping Claude execution on your machine.

## Local / personal use policy note

This wrapper is intended for **local/personal use** in trusted environments.

- Bind to loopback (`127.0.0.1`) unless you fully trust your network.
- Set an API key when sharing a machine or network.
- Do not expose this server publicly without additional hardening and access controls.
- When tools are enabled, Claude Code can read/write files with the OS permissions of the wrapper process.
- For production/commercial use, prefer official Anthropic API/cloud authentication paths and review Anthropic's Claude Code/Agent SDK terms.

## Prerequisites

- Node.js `>=20`
- [Bun](https://bun.sh/) (for development, test, build)
- Claude Code CLI installed and authenticated:

```bash
npm install -g @anthropic-ai/claude-code
claude --version
```

## Install

Global install:

```bash
npm install -g claude-openai-wrapper
```

Run without global install:

```bash
npx -y claude-openai-wrapper
```

## Run

Foreground server with logs in the current terminal:

```bash
claude-openai-wrapper
```

By default it starts at `http://127.0.0.1:8000`.

Debug mode:

```bash
claude-openai-wrapper --debug --port 8000 --api-key dev-local-key
```

Background daemon:

```bash
claude-openai-wrapper --background
```

Daemon management:

```bash
claude-openai-wrapper status
claude-openai-wrapper stop
```

## Configuration (Environment Variables)

Core wrapper variables:

| Variable | Default | Description |
|---|---|---|
| `CLAUDE_WRAPPER_HOST` | `127.0.0.1` | Host/interface to bind the local HTTP server |
| `CLAUDE_WRAPPER_PORT` | `8000` | Local HTTP server port |
| `CLAUDE_WRAPPER_API_KEY` | unset | Optional bearer token required by API endpoints |
| `CLAUDE_WRAPPER_BACKEND` | `sdk` | Backend to use: `sdk` for Claude Agent SDK, `cli` for direct Claude CLI fallback |
| `CLAUDE_WRAPPER_ALLOWED_WORKING_DIR_PREFIXES` | current directory | Comma-separated path prefixes allowed for `claude.workingDirectory` and `claude.addDirs` |
| `CLAUDE_WRAPPER_ALLOWED_PERMISSION_MODES` | `acceptEdits,auto,default,plan` | Allowed permission modes for CLI fallback validation |
| `CLAUDE_DEFAULT_MODEL` | `sonnet` | Default Claude model/alias for `model: claude` and OpenAI aliases |
| `CLAUDE_MODELS_OVERRIDE` | built-in list | Comma-separated model IDs returned by `/v1/models` |
| `CLAUDE_WRAPPER_MAX_REQUEST_BYTES` | `10485760` | Max request body size |
| `CLAUDE_WRAPPER_OUTPUT_DIR` | `~/.claude-openai-wrapper/output` | Captured CLI fallback output directory |
| `CORS_ORIGINS` | `*` | Comma-separated allowed CORS origins |
| `CLAUDE_COMMAND` | `claude` | Claude CLI command/binary used by CLI fallback |

Notes:

- `CLAUDE_WRAPPER_CLAUDE_COMMAND` is also supported.

Example:

```bash
export CLAUDE_WRAPPER_HOST=127.0.0.1
export CLAUDE_WRAPPER_PORT=8000
export CLAUDE_WRAPPER_API_KEY=dev-local-key
export CLAUDE_COMMAND=claude
claude-openai-wrapper
```

## OpenCode configuration example

Point OpenCode (or another OpenAI-compatible client) at this wrapper:

```json
{
  "provider": "openai-compatible",
  "base_url": "http://127.0.0.1:8000/v1",
  "api_key": "dev-local-key",
  "model": "claude-sonnet"
}
```

## API endpoints

- `GET /health` — health check
- `GET /logs` — recent in-memory request logs
- `POST /logs/clear` — clear in-memory request logs
- `GET /v1/models` — model list
- `POST /v1/chat/completions` — chat completions (OpenAI-compatible)

### Streaming support

`POST /v1/chat/completions` supports `"stream": true` and returns Server-Sent Events (`text/event-stream`) with:

- incremental `chat.completion.chunk` messages
- terminal `data: [DONE]`

### Claude Code tools

Tools are disabled by default for OpenAI-compatible chat behavior. Enable Agent SDK tools when you need repo/file access:

```json
{
  "model": "claude-sonnet",
  "stream": true,
  "enable_tools": true,
  "messages": [{"role": "user", "content": "Summarize this repository"}],
  "claude": {
    "workingDirectory": "/path/to/project",
    "toolMode": "readonly"
  }
}
```

Tool modes:

- default: tools disabled, single-turn chat
- `readonly`: `Read`, `Glob`, `Grep`
- `safe`: readonly + `Edit`, `Write`, with `Bash` denied
- `all`: Claude Code preset tools; use only in trusted local workflows

Server-side safety defaults:

- `bypassPermissions` is rejected unless `CLAUDE_WRAPPER_ALLOW_BYPASS_PERMISSIONS=1`.
- Explicit `claude.tools` is rejected unless `CLAUDE_WRAPPER_ALLOW_EXPLICIT_TOOLS=1`.
- `claude.workingDirectory` and `claude.addDirs` must be under `CLAUDE_WRAPPER_ALLOWED_WORKING_DIR_PREFIXES`.

## CLI commands

```bash
claude-openai-wrapper               # start HTTP/SSE wrapper
claude-openai-wrapper --background  # run in background
claude-openai-wrapper status        # show background daemon status
claude-openai-wrapper stop          # stop background daemon
claude-openai-wrapper --version     # print version
claude-openai-wrapper --help        # print usage
claude-openai-wrapper runs          # list known Claude runs
claude-openai-wrapper tail <runId>  # print captured output for a run
claude-openai-wrapper cancel <runId> # cancel an active run
```

## Docker

Build and run foreground server:

```bash
docker build -t claude-openai-wrapper .
docker run --rm -p 127.0.0.1:8000:8000 \
  -e CLAUDE_WRAPPER_API_KEY=dev-local-key \
  -e CLAUDE_WRAPPER_ALLOWED_WORKING_DIR_PREFIXES=/workspace \
  -e CLAUDE_CONFIG_DIR=/home/node/.claude \
  -v "$PWD:/workspace:rw" \
  -v "$HOME/.claude:/home/node/.claude:rw" \
  -v "$HOME/.config/claude:/home/node/.config/claude:rw" \
  claude-openai-wrapper
```

Or with Compose:

```bash
docker compose up --build
```

The image installs `@anthropic-ai/claude-code`, but chat completion still needs valid Claude Code auth/config.

The compose file demonstrates mounting common Claude Code config locations:

- `$HOME/.claude` → `/home/node/.claude`
- `$HOME/.config/claude` → `/home/node/.config/claude`
- your project/workspace → `/workspace`

If your Claude Code subscription login is stored in the host OS keychain instead of these files, the container may not be able to reuse it. In that case, either run the wrapper directly on the host, login inside the container, or use an official API/cloud auth path. `/health` only confirms the wrapper is alive; it does not prove Claude auth works.

## Development

```bash
bun install
bun run dev
bun run typecheck
bun run test
bun run build
```

## License

MIT — see [LICENSE](./LICENSE).
