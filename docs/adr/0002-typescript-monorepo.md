# ADR 0002: TypeScript everywhere in a pnpm workspaces monorepo

- **Status:** Proposed — needs team review
- **Date:** 2026-10-25
- **Deciders:** `@TBD` (all five roles)
- **Related:** [tech-stack.md](../tech-stack.md) · [ADR 0001](0001-modular-monolith.md)

## Context

Five people work in parallel across an API, an SPA, a policy engine, an LLM layer and an eval harness, for 21 days. The same domain objects — money amounts, cart lines, policy decisions, reason codes — appear in all five. Any drift between a frontend's idea of a `PolicyDecision` and the API's is a bug that shows up in the demo.

The architecture in [ADR 0001](0001-modular-monolith.md) depends on boundaries being *enforceable*. We need a repo layout where "the LLM package cannot call PayPal" is a fact about the dependency graph, not a promise in a review comment.

## Decision

**TypeScript (strict) across the whole repo, in a single pnpm workspaces monorepo.**

```
apps/web          apps/api
packages/policy   packages/llm   packages/shared   packages/evals
```

- `packages/shared` owns Zod schemas, domain types and integer-minor-unit money utilities. Everything else imports them; nothing redefines them.
- Workspace dependencies are declared explicitly. `packages/llm` lists no PayPal client, so it cannot import one.
- One lockfile, committed. One CI job runs lint, typecheck and tests across all workspaces.

## Alternatives considered

| Alternative | Assessment |
|---|---|
| **Python API + TypeScript frontend** | Rejected. Python is the more familiar language for LLM work, but it would duplicate every schema across a language boundary, and the duplicate is exactly where money bugs hide. Our LLM layer is thin by design — intent parsing and ranking with structured output — so Python's ecosystem advantage buys little here |
| **Go API** | Rejected. Strong for correctness and concurrency, but a second language, a second toolchain, and no schema sharing with the SPA |
| **Separate repositories per app/package** | Rejected. Cross-repo version coordination for five people over 21 days is pure overhead, and a shared schema change would need three PRs |
| **npm or yarn workspaces** | Viable. pnpm chosen for stricter dependency isolation — a package cannot import something it did not declare, which is precisely the property that enforces our boundaries |
| **Turborepo or Nx on top** | Deferred. Build caching solves a problem we do not have at this size. Revisit if CI exceeds a few minutes |

## Consequences

**Positive**

- One schema definition per contract, shared between API validation, LLM structured-output validation and the SPA.
- Boundary violations surface as missing-dependency errors at build time, in CI, not in review.
- One command (`pnpm test`, `pnpm lint`, `pnpm typecheck`) covers everything; one PR can change a contract and all its consumers atomically.
- The eval harness imports `packages/policy` directly and runs thousands of cases with no network or database.

**Negative**

- pnpm's strictness and workspace protocol cost an hour or two of setup friction early. That is the price of the isolation we want.
- TypeScript's types vanish at runtime: every boundary still needs Zod validation. This is a standing rule, not a one-time task.
- Contributors less familiar with TypeScript carry a learning cost, concentrated in the first days.

**Neutral**

- Node LTS, pinned at scaffold time and recorded in [tech-stack.md](../tech-stack.md#4-versions).
