# Steel MCP Server — containerised build
# Runs the MCP server over stdio. Connect via your MCP client config.
FROM node:22-alpine AS builder

RUN corepack enable pnpm

WORKDIR /app

# Install dependencies (lockfile-only first for layer caching)
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Copy source and build
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

# --- Runtime ---
FROM node:22-alpine

RUN corepack enable pnpm

WORKDIR /app

COPY --from=builder /app/dist /app/dist
COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app/package.json /app/package.json

# Extension assets (for loading into Vivaldi/Chrome via the relay)
COPY extension /app/extension

ENV BROWSER_MODE=steel
ENV STEEL_BASE_URL=http://localhost:3000

# Relay server port (Cookie Push extension)
EXPOSE 3001

ENTRYPOINT ["node", "dist/index.cjs"]
