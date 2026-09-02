# syntax=docker/dockerfile:1
FROM node:20.16.0-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
RUN corepack prepare pnpm@9.12.0 --activate

FROM base AS build
WORKDIR /usr/src/app

RUN apt-get update && apt-get install -y python3 make g++ git python3-pip pkg-config libsecret-1-dev && rm -rf /var/lib/apt/lists/*

RUN mkdir -p apps/api apps/vulseek apps/schedules packages/server packages/server/src/services/dockerfiles packages/trpc-openapi vendor/claude-replay
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/vulseek/package.json ./apps/vulseek/package.json
COPY apps/schedules/package.json ./apps/schedules/package.json
COPY packages/server/package.json ./packages/server/package.json
COPY packages/trpc-openapi/package.json ./packages/trpc-openapi/package.json
COPY vendor/claude-replay/package.json ./vendor/claude-replay/package.json

# Install dependencies before copying source so application edits can reuse this layer.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

COPY . .
RUN mkdir -p agents/mcp

ENV NODE_ENV=production
RUN pnpm --filter=@vulseek/server build
RUN pnpm --filter=./apps/vulseek run build

RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm --filter=./apps/vulseek --prod deploy /prod/vulseek

RUN cp -R /usr/src/app/apps/vulseek/.next /prod/vulseek/.next
RUN cp -R /usr/src/app/apps/vulseek/dist /prod/vulseek/dist

FROM base AS vulseek
WORKDIR /app

# Set production
ENV NODE_ENV=production

RUN apt-get update && apt-get install -y curl unzip zip apache2-utils iproute2 rsync git-lfs && git lfs install && rm -rf /var/lib/apt/lists/*

# Install docker
RUN curl -fsSL https://get.docker.com -o get-docker.sh && sh get-docker.sh && rm get-docker.sh && curl https://rclone.org/install.sh | bash

# Install Nixpacks and tsx
# | VERBOSE=1 VERSION=1.21.0 bash

ARG NIXPACKS_VERSION=1.39.0
RUN curl -sSL https://nixpacks.com/install.sh -o install.sh \
    && chmod +x install.sh \
    && ./install.sh \
    && pnpm install -g tsx \
    && npm install -g ccusage@20.0.20 \
    && command -v ccusage >/dev/null \
    && ccusage --help >/dev/null

# Install Railpack
ARG RAILPACK_VERSION=0.2.2
RUN curl -sSL https://railpack.com/install.sh | bash

# Install buildpacks
COPY --from=buildpacksio/pack:0.35.0 /usr/local/bin/pack /usr/local/bin/pack

# Copy only the necessary files after installing runtime tools so app edits reuse
# the expensive tool-install layers.
COPY --from=build /prod/vulseek/.next ./.next
COPY --from=build /prod/vulseek/dist ./dist
COPY --from=build /prod/vulseek/next.config.mjs ./next.config.mjs
COPY --from=build /prod/vulseek/public ./public
COPY --from=build /prod/vulseek/package.json ./package.json
COPY --from=build /prod/vulseek/drizzle ./drizzle
COPY .env.production ./.env
COPY --from=build /prod/vulseek/components.json ./components.json
COPY --from=build /prod/vulseek/node_modules ./node_modules
RUN find .next/node_modules -type l -print | while IFS= read -r link; do \
		target="$(readlink "$link")"; \
		case "$target" in \
			*node_modules/.pnpm/*) \
				ln -sfn "/app/node_modules/${target#*node_modules/}" "$link" ;; \
		esac; \
	done \
	&& find .next/node_modules -type l -print | while IFS= read -r link; do test -e "$link"; done
COPY --from=build /usr/src/app/agents/skills ./agents/skills
COPY --from=build /usr/src/app/agents/cache-schema ./agents/cache-schema
COPY --from=build /usr/src/app/agents/mcp ./agents/mcp
COPY --from=build /usr/src/app/agents/codex-config.toml ./agents/codex-config.toml

EXPOSE 3000
CMD [ "pnpm", "start" ]
