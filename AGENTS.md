# Repository Guidelines

## Engineering Principles

- Do not optimize for backward compatibility. Remove deprecated code paths directly instead of adding compatibility layers or fallback mechanisms; migrate database data when necessary.
- Once the current requirements are fully satisfied, prefer the simplest implementation possible. Avoid abstractions, configuration options, and indirection that are not justified by an actual need.
- Build the system incrementally and in layers. First deliver the smallest end-to-end version that works, then add capabilities step by step on top of a stable product. Do not replace a usable product with immature complexity.
- Keep components modular and define responsibilities and boundaries clearly.
- Prefer mature, well-maintained libraries when they reduce overall complexity or improve reliability. Do not reimplement general-purpose functionality without a clear reason.
- Before implementing functionality or adding dependencies, evaluate the capabilities of the project's existing dependencies first. Consult relevant documentation and type definitions rather than assuming a library lacks the required capability.
- Make architectural decisions with long-term evolution in mind. Avoid temporary solutions that solve only the current problem and are expected to be replaced later.
- Before designing a solution, study how mature products solve similar problems. Prefer proven patterns and conventions instead of designing an entirely new approach from scratch.

## Project Structure & Module Organization

Dokploy is a `pnpm` workspace with app entrypoints in `apps/*` and shared code in `packages/*`. The main web product lives in `apps/dokploy` (Next.js UI, server bootstrap, Drizzle migrations, tests, and Docker scripts). Supporting services live in `apps/api`, `apps/schedules`, and `apps/monitoring`. Shared backend logic is in `packages/server/src`. Treat `third_party/` as vendored code: avoid changing it unless the task explicitly targets that subtree.

## Build, Test, and Development Commands

Use Node `20.16.x` and `pnpm >= 9.12`.

- `pnpm install`: install workspace dependencies.
- `pnpm dokploy:setup`: initialize local services and run app setup.
- `pnpm server:script`: switch the shared server package to source mode for development.
- `pnpm dokploy:dev`: start the main app on `localhost:3000`.
- `pnpm build`: build all workspace packages.
- `pnpm typecheck`: run TypeScript checks across the workspace.
- `pnpm format-and-lint` or `pnpm check`: run Biome checks.
- `pnpm test`: run the `apps/dokploy` Vitest suite.

## Coding Style & Naming Conventions

Biome is the formatter and linter; prefer it over Prettier or ad hoc editor formatting. Use tabs for indentation, matching the existing TypeScript and JSON files. Follow Conventional Commits and existing scoped subjects such as `feat(scan): ...` or `fix(ui): ...`. Use PascalCase for React components, camelCase for functions and variables, and keep new package or app directories lowercase.

## Testing Guidelines

Current automated tests are centered in `apps/dokploy/__test__` and run with Vitest (`pnpm test`). Add or update tests when changing UI flows, API behavior, or migration-sensitive code. Keep test files near the current convention, for example `apps/dokploy/__test__/feature-name.test.ts`. Run `pnpm typecheck` and the relevant app tests before opening a PR.

## Commit & Pull Request Guidelines

Commit messages must follow Conventional Commits; commitlint is configured in the repo even if the sample `lefthook` commands are commented out. Base contribution branches on `canary`, keep each PR focused, and link the related issue when applicable. PR descriptions should explain the user-visible change, note any setup or migration impact, and include screenshots or video for UI work.
