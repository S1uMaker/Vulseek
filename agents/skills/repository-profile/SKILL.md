---
name: repository-profile
description: Build repository context and split the repository into downstream vulnerability-mining modules.
---

# Repository Profile

## Purpose

Create repository-level context and split the checked-out repository into modules for downstream generic vulnerability mining.

This stage is a routing stage. It should preserve security-relevant module boundaries while removing obvious repository noise.

This stage may use lightweight threat-model reasoning to choose module boundaries, but it must not generate vulnerability candidates or confirmed findings.

## Inputs

Use the paths, runtime metadata, and schemas provided by the stage prompt.

Expected inputs include:

- checked-out repository
- task directory
- repository state
- output schema
- repository artifact path
- module artifact directory
- output manifest path

## Outputs

Write these artifacts:

- `/task/repository.json` — repository-level fields only; no module details
- one module JSON file per module — required schema fields exactly; use `name`, not `title`
- `/task/output.json` — path manifest only (`repository` and `modules` are artifact paths, not objects)

Use the injected schemas as the source of truth.

## Workflow

Follow one pass:

1. Read repository metadata.
2. Inventory the repository structure.
3. Detect repository context.
4. Identify runtime areas, security surfaces, and obvious noise areas.
5. Inspect enough source content and repository structure to justify module boundaries.
6. Split the repository into modules.
7. Apply large-module splitting before writing module artifacts.
8. Set module priority fields.
9. Write artifacts.
10. Validate artifacts.

## Module Splitting Policy

Create modules that preserve runtime and security-relevant boundaries for downstream attack-surface modeling and target identification.

A module should group code that shares a similar runtime role, trust boundary, threat model, privilege level, language/runtime integration point, or security responsibility.

Noise filtering happens before module splitting, but it must not merge distinct runtime or security boundaries.

Prefer boundaries in this order:

1. Explicit ownership boundaries

   Use repository-defined boundaries when they exist:

   - app
   - package
   - service
   - crate
   - contract
   - program
   - binary
   - deployable component

2. Entry and trust boundaries

   Split code where untrusted or less-trusted input enters the system or crosses into a more-trusted context.

   Consider:

   - HTTP, RPC, CLI, webhook, queue, worker, browser, plugin, LLM tool, GraphQL, server action, controller, middleware, or smart contract entrypoints
   - user input, network input, uploaded files, parsed documents, queue messages, third-party API responses, database-loaded state, environment variables, filesystem state, plugin output, or LLM output

3. Sensitive responsibility boundaries

   Split code that performs, guards, or validates security-sensitive behavior.

   Consider:

   - authentication, authorization, sessions, tokens, admin actions, permission checks
   - database writes, filesystem access, command execution, network requests
   - cryptography, payments, billing, secrets, tool execution, plugin execution
   - parsing, decoding, normalization, validation, verification, sanitization, policy enforcement

4. Runtime component and threat-model boundaries

   Split components with different execution contexts, privileges, deployment modes, consumers, attacker models, or failure modes.

   Consider:

   - API server, web app, worker, CLI, frontend, backend, core library, language binding, integration provider, platform adapter, deployment or infrastructure component
   - unauthenticated user-facing code, authenticated user actions, admin-only functionality, internal service-to-service code, sandboxed execution, plugin runtime, LLM agent/runtime, supply-chain or build logic, smart contract/on-chain execution

5. Core responsibility and directory fallback

   When stronger boundaries are not obvious, split by core responsibility observed from source content.

   If evidence is weak, use top-level runtime directories and record a short note that the boundary is path-derived.

Choose the module set from the repository's actual scale and complexity.

Large repositories may produce more than 20 modules when that is needed to preserve distinct security surfaces.

When two splits are both reasonable, choose the one that better separates trust boundaries, runtime roles, privilege levels, language/runtime integration points, and sensitive responsibilities.

When uncertain between merging and splitting, split if downstream module scanning would otherwise mix different trust boundaries, attacker-controlled inputs, runtime contexts, privilege levels, language/runtime integration points, or security responsibilities.

Do not split modules by individual functions, speculative vulnerabilities, or extra exploration done only to perfect the boundary.

## Large Module Splitting

Before writing module artifacts, review each candidate module for signs that it is an aggregate module that should be split structurally.

A candidate module should be split when it combines multiple independent security surfaces, for example:

- different external entrypoints, such as API endpoints, CLI commands, background workers, event consumers, webhooks, plugins, embedded runtimes, daemons, libraries, tools, or generated bindings
- different execution environments, such as frontend, backend, worker, CLI, mobile, embedded, kernel, sandboxed, serverless, browser extension, build-time, or release-time code
- different trust or privilege contexts, such as unauthenticated user paths, authenticated user paths, admin paths, internal service paths, privileged system paths, local-only tools, or third-party extension points
- different data ownership or tenancy boundaries, such as user data, organization data, project/workspace data, credentials, secrets, billing data, audit data, cached data, or shared global state
- different stateful subsystems, such as sessions, queues, schedulers, transactions, caches, locks, configuration, migrations, synchronization, retry/recovery, or lifecycle management
- different storage and I/O surfaces, such as database access, filesystem access, network access, IPC, device access, message buses, object storage, logs, telemetry, imports, exports, or uploads/downloads
- different input interpretation layers, such as request handling, command handling, file import, serialization, deserialization, validation, normalization, transformation, template rendering, or policy evaluation
- different integration layers, such as SDKs, adapters, drivers, compatibility layers, language bindings, FFI, provider integrations, platform ports, or framework glue
- different implementation families or backends, such as pure runtime logic, optimized backends, platform-specific implementations, optional feature implementations, generated adapters, or hardware/service-backed implementations
- different operational surfaces, such as installer code, packaging, deployment, configuration, update flows, release tooling, CI/CD helpers, tests that execute runtime behavior, fuzz harnesses, or examples that expose real entrypoints

Use source-backed structural signals to split aggregate modules:

- directory names and file names
- package, crate, app, service, binary, command, plugin, extension, or deployable boundaries
- build-system targets, manifests, dependency groups, and conditional feature flags
- exported public APIs, route tables, command registries, provider registries, plugin registries, or schema definitions
- filename prefixes or suffixes that identify ownership domains, runtime roles, adapters, backends, platforms, bindings, commands, jobs, or data formats
- nearby README, manifest, config, Kconfig, CMake, autotools, package metadata, service descriptors, or deployment metadata that identifies runtime roles
- repeated source-file clusters with separate entrypoints, state owners, trust boundaries, storage surfaces, or integration responsibilities

Avoid broad module artifacts whose `files` field is only a large catch-all directory when that directory contains separable security surfaces.

Do not treat a broad application, package, library, service, platform, tooling, integration, or binding directory as one module when source files clearly separate multiple runtime roles, entrypoints, state owners, storage surfaces, trust boundaries, execution environments, integration layers, or operational surfaces.

Do not merge code that has separate entrypoints, ownership boundaries, trust boundaries, privilege levels, data lifecycles, storage/I/O responsibilities, execution environments, or integration responsibilities.

When a candidate module is split, each child module should still be a meaningful downstream scan unit with coherent files, entrypoints, trust boundaries, attack surfaces, and notes. Record in notes when a module was split from a larger aggregate surface.

## Noise Handling

Exclude or downscope repository areas that are clearly noise for downstream security scanning:

- vendored dependencies, copied third-party source, submodules, and package manager caches
- generated files, generated mirrors, build outputs, minified bundles, and compiled artifacts
- documentation-only directories, screenshots, static media, and marketing assets
- test fixtures, sample certificates, sample keys, corpora, golden files, snapshots, and large data assets
- boilerplate packaging metadata with no install, build, signing, release, or dependency-resolution behavior
- compatibility aliases that only re-export another already-covered runtime area

Do not create separate modules for pure noise areas unless they are explicitly part of the runtime attack surface, build pipeline, packaging trust boundary, fuzz/test harness behavior, or security configuration surface.

If a noisy area is intentionally included, explain why in module notes.

When an area contains both noise and security-relevant code, keep the security-relevant code in the appropriate module and note the excluded noise.

## Priority Field

Set numeric priority.

- `0`: externally reachable or security-critical module
- `1`: high-value module with indirect exposure
- `2`: normal runtime logic
- `3`: support, config, deployment, docs, tests, examples, generated code, or static assets

## Boundaries

Stay within the repository-stage contract.

Do not produce target inventories, function inventories, vulnerability candidates, exploit hypotheses, detailed attack paths, call graphs, or data-flow summaries.

Do not run commands that install dependencies, build, test, fuzz, modify repository state, use external services, or perform web/network access.

Inspect enough files and directory structure to justify module boundaries. Prefer source-backed boundaries over purely top-level directory guesses.

## Validation

Before finishing, validate that:

- all required artifacts exist
- all JSON artifacts are parseable
- artifacts conform to the injected schemas
- module IDs are unique
- module artifact filenames match module IDs
- the output manifest contains artifact paths only

If validation fails, fix the artifacts once.

If uncertainty remains, record it in notes and finish.
