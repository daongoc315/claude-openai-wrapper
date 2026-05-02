FROM oven/bun:1.3.11 AS build
WORKDIR /app

COPY package.json bun.lock tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN bun install --frozen-lockfile
RUN bun run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    CLAUDE_WRAPPER_HOST=0.0.0.0 \
    CLAUDE_WRAPPER_PORT=8000 \
    HOME=/home/node \
    CLAUDE_CONFIG_DIR=/home/node/.claude

RUN npm install -g @anthropic-ai/claude-code

COPY package.json ./package.json
COPY --from=build /app/dist ./dist

RUN mkdir -p /home/node/.claude /home/node/.config/claude /workspace \
  && chown -R node:node /home/node /workspace /app

USER node

EXPOSE 8000
CMD ["node", "dist/index.js"]
