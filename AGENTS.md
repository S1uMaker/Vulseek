# AGENTS.md

This file provides guidance to AI coding agents (e.g. Claude Code, Codex CLI, ZCode) when working with code in this repository.

## Engineering Principles

- Do not optimize for backward compatibility. Remove deprecated code paths directly instead of adding compatibility layers or fallback mechanisms; migrate database data when necessary.
- Once the current requirements are fully satisfied, prefer the simplest implementation possible. Avoid abstractions, configuration options, and indirection that are not justified by an actual need.
- Build the system incrementally and in layers. First deliver the smallest end-to-end version that works, then add capabilities step by step on top of a stable product. Do not replace a usable product with immature complexity.
- Keep components modular and define responsibilities and boundaries clearly.
- Prefer mature, well-maintained libraries when they reduce overall complexity or improve reliability. Do not reimplement general-purpose functionality without a clear reason.
- Before implementing functionality or adding dependencies, evaluate the capabilities of the project's existing dependencies first. Consult relevant documentation and type definitions rather than assuming a library lacks the required capability.
- Make architectural decisions with long-term evolution in mind. Avoid temporary solutions that solve only the current problem and are expected to be replaced later.
- Before designing a solution, study how mature products solve similar problems. Prefer proven patterns and conventions instead of designing an entirely new approach from scratch.

## Project Overview

**Vulseek** is a security-focused fork of Dokploy — a self-hostable Platform-as-a-Service (PaaS). Vulseek extends Dokploy with an AI-powered multi-stage vulnerability scanning pipeline that uses LLM agents inside sandbox containers to discover, analyze, and verify security vulnerabilities in source code repositories.

Core upstream: Next.js frontend + tRPC API backend + PostgreSQL + Redis + Docker.

**Deployment modes** — The system runs in two modes controlled by `IS_CLOUD` env var:
- **Self-hosted** (`IS_CLOUD !== "true"`): Vulseek manages its own Docker engine. Starts Traefik, networks, cron jobs, BullMQ workers, and auto-delta-scan polling on boot.
- **Cloud** (`IS_CLOUD === "true"`): Managed service mode. Only runs DB migration and env sync — no local Docker management. The `apps/api` service handles deployment via Inngest.

## Tech Stack

- **Runtime**: Node.js v20.16.0 (use `.nvmrc`)
- **Package Manager**: pnpm v9.12.0+
- **Monorepo**: pnpm workspaces (`apps/*`, `packages/*`)
- **Frontend**: Next.js 15 (pages router), React 18, Tailwind CSS, Radix UI
- **API**: tRPC v10, superjson transformer
- **Database**: PostgreSQL with Drizzle ORM
- **Authentication**: better-auth v1.2.8-beta.7 (session-based)
- **Formatting/Linting**: Biome (NOT Prettier), lefthook for git hooks
- **Testing**: Vitest with `vite-tsconfig-paths`
- **Deployment**: Docker, Docker Swarm
- **Queues**: BullMQ (Redis-backed)
- **AI**: Vercel AI SDK (`ai` v5); agent profiles support both **Codex** and **Claude Code** providers with configurable `api_key` or `host_home` auth modes

## Common Commands

```bash
# Development
pnpm run vulseek:dev          # Start development server (Next.js + API)
pnpm run vulseek:dev:turbopack # Start with Turbopack
# NOTE: if dev pages 404 with a Turbopack panic ("CJS module can't be async"),
# rm -rf apps/vulseek/.next and restart without turbopack.
pnpm run vulseek:setup         # Initial setup (creates .env, runs migrations)
pnpm run server:script         # Switch packages/server to dev mode (src imports)

# Building
pnpm run vulseek:build         # Build for production (esbuild server + next build)
pnpm run vulseek:start         # Start production server
pnpm run docker:build:canary   # Build Docker image

# Code Quality
pnpm run format-and-lint       # Check biome
pnpm run format-and-lint:fix   # Fix biome issues
pnpm run typecheck             # TypeScript type checking (all packages)

# Database (run from repo root)
pnpm --filter=vulseek run migration:generate  # Generate Drizzle migration
pnpm --filter=vulseek run migration:run        # Run migrations
pnpm --filter=vulseek run db:studio            # Open Drizzle Studio
pnpm --filter=vulseek run db:push              # Push schema directly to DB

# Testing
pnpm run test                    # Run all tests
pnpm --filter=vulseek run test   # Run tests in vulseek app only
pnpm vitest run __test__/compose/compose.test.ts  # Run a single test file
pnpm vitest __test__/compose/                     # Watch mode for a directory
```

> Known environment limitation: `.tsx` component tests fail with `ERR_REQUIRE_ESM` in this setup (jsdom import chain on Node 20.16). Pre-existing and environmental — don't chase them; the scan contract tests under `packages/server/src/services/scan/` are the reliable suite.

### Docker Swarm dev environment (`dev.sh`)

An alternative dev workflow runs the whole stack (Vulseek, Postgres, Redis, Traefik) as Docker Swarm services, matching production orchestration more closely than the bare `pnpm run vulseek:dev` flow above:

```bash
./dev.sh init             # Initialize Docker Swarm (first time only)
./dev.sh build             # Build the dev image
./dev.sh start              # Deploy services
./dev.sh status             # Show service status/URLs
./dev.sh logs vulseek       # Tail a service's logs
./dev.sh shell               # Shell into the main container (or `./dev.sh shell postgres`)
./dev.sh update vulseek      # Redeploy after code changes
./dev.sh db:migrate | db:seed | db:studio
./dev.sh test | lint | format
./dev.sh stop                # Tear down
```

`run.sh` is the equivalent manager for the released GHCR image (`vulseek-*-release` services). Development defaults the scan sandbox host mount to `./vulseek-data-dev`; release uses `./vulseek-data-release`. Override either with `VULSEEK_SCAN_CONTEXT_HOST_PATH`.

### Bare-metal dev on this machine (WSL2 + Docker Desktop)

The operative workflow here is **not** `dev.sh`: `pnpm vulseek:dev` runs against standalone Docker services named `vulseek-postgres`, `vulseek-redis` (swarm services under legacy names that do NOT match the `*-dev` variables in dev.sh) and a standalone `vulseek-traefik` container. Therefore `./dev.sh stop` cannot remove the legacy-named services and `./dev.sh start` would deploy a parallel stack — manage them with `docker service` / `docker` directly. Real connection strings live in `apps/vulseek/.env` (gitignored); a scan run additionally requires `VULSEEK_SCAN_CONTEXT_HOST_PATH`, `VULSEEK_RUNTIME_API_SECRET` and `VULSEEK_RUNTIME_API_URL` (see `.env.example`).

Windows Hyper-V dynamic port exclusions shift across reboots and can swallow fixed ports — postgres 5432 → 25432 and redis 6379 → 26379 both happened on this host. If a port refuses connections from the host while its container is healthy, check `netsh.exe interface ipv4 show excludedportrange protocol=tcp` and republish on a port outside the excluded ranges.

## Architecture

### Monorepo Structure

```
apps/
├── vulseek/          # Main app (Next.js frontend + tRPC API + BullMQ workers)
├── api/              # Deployment API service (Hono + Inngest, event-driven)
├── monitoring/       # Monitoring service (Go + Fiber)
└── schedules/        # Scheduling service (Hono + BullMQ, cron backups)

packages/
└── server/           # @vulseek/server — business logic, DB schemas, scan pipeline, builders

agents/
└── skills/           # AI agent skill definitions (Markdown) for each scan stage
```

### Microservices Detail

- **`apps/api`** — Hono REST service. Receives deployment requests and dispatches them via Inngest (event-driven, concurrency 1 per serverId, supports cancellation, no retries).
- **`apps/monitoring`** — **Go** (Fiber HTTP) service. Collects system/container metrics on configurable intervals, stores in embedded DB, sends threshold-violation callbacks to Vulseek.
- **`apps/schedules`** — Hono REST service. Manages cron-scheduled backup jobs via BullMQ repeatable jobs (3 workers × 100 concurrency).

### Server Entrypoints

- **Dev**: `apps/vulseek/server/server.ts` (run via `tsx`)
- **Prod**: `apps/vulseek/dist/server.mjs` (built via esbuild)
- Startup sequence: Next.js → WebSocket server → (self-hosted: Traefik config, network, cron, BullMQ workers, auto-delta-scan)

### API Layer (tRPC)

tRPC routers in `apps/vulseek/server/api/routers/` delegate to services in `packages/server/src/services/`. Routers handle HTTP concerns; services contain business logic.

**Procedure types** (`apps/vulseek/server/api/trpc.ts`):
- `publicProcedure` — unauthenticated
- `protectedProcedure` — valid session + user required
- `adminProcedure` / `cliProcedure` — `role === "owner"`
- `uploadProcedure` — multipart form data (2GB max)

Context: `session`, `user` (with `role`, `ownerId`), `db`, `req`, `res`.

### Database

PostgreSQL + Drizzle ORM. Schemas in `packages/server/src/db/schema/`, migrations in `apps/vulseek/drizzle/`. Key Vulseek schema additions: `scan_jobs` (with `status`, `paused`/`failed`/`canceled` support), `tasks` (with `scanStage` metadata), `scanStageSettings`, `agentProfiles`.

### Authentication & Multi-Tenancy

`better-auth` session-based auth. Roles: `owner`, `admin`, `member`. Multi-tenant via `activeOrganizationId` session field.

### Docker Integration & Traefik

- Uses `dockerode` library. Supports local Docker (`/var/run/docker.sock`) and remote servers (SSH via `ssh2`).
- Traefik handles reverse proxy, SSL (Let's Encrypt ACME), HTTP/3. Two modes: standalone container (single-node) and Swarm Service (cluster). Dynamic YAML config in `/etc/vulseek/traefik/dynamic/`.

### Application Builders

Five strategies in `packages/server/src/utils/builders/`: Nixpacks, Dockerfile, Herokuish, Paketo, Static.

---

## Vulseek Scan Pipeline

This is the primary Vulseek contribution — an AI-driven multi-stage vulnerability scanning system.

### Scan Job Lifecycle

Scan jobs progress through states: `pending` → `running` → `finalizing` → `finished` / `partially_finished`, plus `failed` / `paused` / `canceled` (see `scanJobStatusEnum` in `packages/server/src/db/schema/scan.ts`; there is no `completed` status). The settlement loop moves a converged graph `running` → `finalizing` (`settleScanJobRepo`) → `finished` (`finalizeScanJobRepo`) in `persistence/job-settlement.repo.ts`; only terminal jobs (`finished`, `partially_finished`, `failed`, `canceled`) can be deleted. Jobs support **pause**, **resume**, and **cancel** operations. Scan modes:
- **Full scan** — complete repository analysis from scratch
- **Delta scan** — incremental re-scan of changed modules since the last scan
- **Research** — security research pipeline (`research.yaml`)
- **ToB Goal** — targeted objective-based pipeline (`tob-goal.yaml`)

The `auto-delta-scan` utility (`apps/vulseek/server/utils/auto-delta-scan.ts`) periodically polls for new commits and triggers delta scans.

### Full & Delta Scan Pipelines — YAML-Defined Graph

The pipeline topology used to be two parallel branches (a rule/pattern-matching branch and a function-level deep-analysis branch) hardcoded in TypeScript. That was removed (`refactor(scan): remove legacy stages`) in favor of a single, declarative pipeline defined in YAML and executed by a generic graph runner:

- **Definitions**: `packages/server/src/services/scan/pipeline/definitions/`
  - `pipelines/{full,delta,research,tob-goal}.yaml` — the stage list, root stage, and edges (with `fanOut`/`map` modes and `$ctx.` / `$input.` / `$item` / `$computed.` templated input mapping) for each pipeline
  - `stages/*.yaml` — per-stage config: `key`, `role`, `group`, `concurrency`, `disableable`, and `runtimeConfig` (agent profile, `persistent`/`reuseContainer`, `skills`, `promptFile`, input/output schema refs)
  - `schemas/*.yaml` — shared JSON Schema fragments referenced via `$ref: "#/schemas/Name"`
- **Loading & validation**: `scan-pipeline-definitions.ts` reads and Zod-validates the YAML into `ScanPipelineStageConfig`/`ScanPipelineEdgeConfig`; `scan-pipeline-schema-contracts.ts` resolves `$ref`/`$pathOf` schema references into JSON Schema or Zod contracts.
- **Execution**: `pipeline-runner.ts` is a generic DAG executor over `StageDefinition`s (`packages/server/src/services/scan/stages/*.stage.ts`) driven by the loaded edges — it doesn't know about specific stages, just how to fan out, map, route, and loop between them.

**These YAML files are seeding templates only.** At startup they seed the built-in pipelines into the DB (`scan_pipelines` / `scan_pipeline_versions` / `scan_pipeline_profiles`); every run executes the **published version** stored in the DB (draft → publish model, with per-pipeline runtime profiles). Editing a definition file does not change what runs until it is re-seeded or the change is made through the pipeline editor/publish flow.

```
full:  repository-profile ─(fanOut modules)─► attack-surface-model ─► identify-target ─(fanOut targets)─► scan-target
                                                                                                              │
delta:                                                     delta-scope ─(fanOut functions)─► scan-target ◄──┘
                                                                                                              │
                                                                                            (fanOut candidates)
                                                                                                              ▼
                                                                          analyze-finding ⇄(critic loop)⇄ critique-finding
                                                                                                              │
                                                                                                              ▼
                                                                                         verify-finding ─► triage-finding
```

#### Stage Summary

| Stage | AI Agent? | Purpose |
|-------|:---------:|---------|
| `delta-scope` | ✓ | Determine which modules/functions changed since last scan (delta pipeline root) |
| `repository-profile` | ✓ | Profile repository structure, identify modules (full pipeline root) |
| `attack-surface-model` | ✓ | AI-driven attack surface / threat-model analysis for a module |
| `identify-target` | ✓ | Identify high-value vulnerability targets within a module |
| `scan-target` | ✓ | Deep vulnerability scan on a specific target (file/function/API), emits candidates |
| `analyze-finding` | ✓ | In-depth analysis of a candidate (CodeQL, path tracing); loops with `critique-finding` |
| `critique-finding` | ✓ | Adversarial critic that challenges or approves the draft analysis, routes back to `analyze-finding` |
| `verify-finding` | ✓ | Final verification of the critic-approved analysis |
| `triage-finding` | ✗ | Classify, score (CVSS, EPSS), and prioritize verified findings |

Stage IDs are canonical across YAML definitions, task records, queues, APIs, and UI. Do not add aliases for retired stage names.

### Agent Runtime Architecture

Each AI-powered stage runs an agent inside a **Docker sandbox container**:
- Container orchestrated via `agent-stage-runtime.ts` — handles launch, reuse, persistence, thread management
- Agent communicates via structured JSON output (Zod schemas validated at each stage)
- Supports **persistent containers** across related stages (e.g., attack-surface-model → identify-target → scan-target share a container via `laneThreadId`)
- `codexHome` and `host_home` modes for agent auth
- `runSingleTurnAgentInContainer` (`runtime/run-single-turn-agent.ts`) — the core agent invocation primitive
- `runAgentStageRuntime` — manages container lifecycle, task directories, stage input/output

### Agent Skills

Agent skill definitions live in `agents/skills/<name>/SKILL.md` (plus reference/workflow docs for some, e.g. `codeql/references/`, `codeql/workflows/`). Referenced by stage YAML (`skills:` list) and passed into the sandbox container. Stage skills include `delta-scope`, `repository-profile`, `attack-surface-model`, `identify-target`, `scan-target`, `analyze-finding`, `critique-finding`, and `verify-finding`. Shared skills include `full-scan`, `full-scan-subagent`, `delta-scan`, `codeql`, `semgrep`, `tree-sitter`, `libafl`, `build-fuzzer`, `run-fuzzer`, `address-sanitizer`, `coverage-analysis`, and `search-registries`.

### Candidate Management

Vulnerability **candidates** flow through the pipeline as structured JSON artifacts:
- `candidate-id.ts` — deterministic candidate ID generation
- `candidate-manifest-normalizer.ts` — rewrites candidate IDs in manifests after stage outputs, deduplicates against seen IDs
- Artifact contracts (`artifacts/contracts/domain-object.contract.ts`) — Zod schemas for all domain objects (Candidate, RuleFinding, Module, Target, Analysis, Verification, Triage, etc.)
- Task artifacts read/written via `artifacts/task-artifact-paths.ts`

### Queue Architecture

| Queue | Worker | Purpose | Concurrency |
|-------|--------|---------|-------------|
| `deployments` | `deploymentWorker` | App/Compose/Preview deployment (local + remote) | — |
| `scans` | `scansWorker` | Full & delta scan job execution | 16 (plus semaphore for scan-level limit) |
| `scan-evaluations` | `scanEvaluationsWorker` | Post-scan evaluation | 2 |

The scans-queue uses a **semaphore** (`acquireScanExecutionSlot`) that allows fine-grained concurrency beyond the worker count — limits concurrent scan *executions* (not just BullMQ jobs).

Stage-level concurrency is further controllable via `resolveStageConcurrencySetting`, which respects per-stage defaults (e.g., `analyze` = 2, `verify` = 1, module stages = 4).

**Queue job deduplication** (`queue-job-ids.ts`): Maps stage names to deduplication keys so that related tasks share queue slots instead of competing independently, e.g. `delta-scope` → `delta-scope:scanJobId`, `repository-profile` → `repository:scanJobId`, `identify-target` → `module:taskId`, `attack-surface-model` → `attack-surface-model:taskId`, `scan-target` → `function:taskId`, `analyze-finding` → `analysis:taskId`, `verify-finding` → `verification:taskId`.

### WebSocket System

Handlers in `apps/vulseek/server/wss/`:
- `docker-container-terminal.ts` — interactive Docker container terminals (xterm.js)
- `docker-container-logs.ts` — streaming container logs
- `docker-stats.ts` — real-time resource stats (self-hosted only)
- `listen-deployment.ts` — deployment status updates
- `scan-stats.ts` — live token throughput, scan progress, task status streaming (self-hosted only)
- `terminal.ts` + `drawer-logs.ts` — server-side terminal/log streaming

### UI — Scan-Specific Pages

- `pages/dashboard/scanning/` — scan job listing, creation, detail views
- `pages/dashboard/scan-review-terminal.tsx` — scan review terminal for agent interaction (new in Vulseek)
- `show-scan-stage-graph.tsx` — interactive scan pipeline DAG visualization
- `show-scan-candidate-detail.tsx` — vulnerability candidate drill-down
- Agent profile configuration (`show-agent-profile.tsx`)
- Local file directory provider selector for source input

### Key Vulseek Schema Additions

- `scanStageSettings` — per-stage agent profile + concurrency configuration
- `scanRuntimeSettings` — runtime stage toggling (enable/disable stages)
- `agentProfiles` — Codex/Claude Code agent configurations (model, provider, auth mode, thinking level, envs)
- `autoDeltaScan` — per-application auto-delta-scan toggle (default `false`)
- `localSourceType` — local directory-based source provider

### i18n

Uses `next-i18next`. Locale files: `apps/vulseek/public/locales/{en,zh-Hans}/`. Scan-related strings in `scan.json`.

### Key Package Exports (`@vulseek/server`)

```json
{
  ".": "./src/index.ts",
  "./db": "./src/db/index.ts",
  "./db/schema": "./src/db/schema/index.ts",
  "./db/schema/*": "./src/db/schema/*.ts",
  "./setup/*": "./src/setup/*.ts",
  "./constants": "./src/constants/index.ts"
}
```

Dev mode (`pnpm run server:script`): imports resolve to `src/`. Production: resolve to `dist/`.

### Patched Dependencies

The scan-tools image installs the official ACP SDK and agent adapters. Codex fork
support is added by
`packages/server/src/services/dockerfiles/codex-acp-fork-1.1.2.patch` while the
upstream adapter does not expose `session/fork`.

## Code Conventions

### Commit Messages

Uses **Conventional Commits** via commitlint (`@commitlint/config-conventional`). Format: `type(scope): description`. Common types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`. Work directly on `main` — commit and push without feature branches (maintainer's workflow).

### Biome Lint Rules (errors that block commits)

- `noUnusedImports: error` — remove all unused imports
- `noUnusedFunctionParameters: error` — remove or prefix with `_`
- `noParameterAssign: error` — never reassign function parameters
- `noInferrableTypes: error` — don't annotate types that TS can infer
- `noUselessElse: error` — no `else` after `return`/`throw`/`break`
- `useAsConstAssertion: error` — prefer `as const`
- `useSelfClosingElements: error` — `<Foo />` not `<Foo></Foo>`
- `noUnusedTemplateLiteral: error` — use plain strings when no interpolation

Run `pnpm run format-and-lint` to check, `pnpm run format-and-lint:fix` to auto-fix. The `check` script (used by lint-staged on pre-commit) writes fixes in place.

### Path Aliases (in tests)

Vitest resolves these aliases (see `apps/vulseek/__test__/vitest.config.ts`):
- `@/` → `apps/vulseek/`
- `@vulseek/server` → `packages/server/src/`

## Development Setup

```bash
# 1. Install dependencies
pnpm install

# 2. Copy environment file
cp apps/vulseek/.env.example apps/vulseek/.env

# 3. Setup
pnpm run vulseek:setup

# 4. Switch to dev mode (src imports for @vulseek/server)
pnpm run server:script

# 5. Start development
pnpm run vulseek:dev
```

## Testing

Tests in `apps/vulseek/__test__/`. Uses Vitest with `vite-tsconfig-paths` and `pool: "forks"`. Test config at `apps/vulseek/__test__/vitest.config.ts`. Vulseek has scan-specific contract tests in `packages/server/src/services/scan/` (e.g., `pipeline/scan-pipeline-definitions.test.ts`, `pipeline/scan-pipeline-yaml-contracts.test.ts`, `pipeline/pipeline-routing.test.ts`, `pipeline/scan-pipeline-edge-transform.test.ts`, `retry-failed-tasks.test.ts`, `state/scan-state-machine.test.ts`).

```bash
pnpm run test
pnpm vitest run __test__/compose/compose.test.ts
pnpm vitest __test__/compose/
pnpm vitest run __test__/ -t "test name pattern"
```
