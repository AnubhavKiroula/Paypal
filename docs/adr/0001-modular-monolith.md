# ADR 0001: Modular monolith with durable background jobs

- **Status:** Proposed — needs team review
- **Date:** 2026-10-25
- **Deciders:** `@TBD` (all five roles)
- **Related:** [architecture.md](../architecture.md) · [tech-stack.md](../tech-stack.md) · [ADR 0002](0002-typescript-monorepo.md)

## Context

Mandate must execute real PayPal sandbox payments from deployed code by **Oct 27** and reach an end-to-end MVP by **Nov 2**, with five people. The correctness-critical part of the system is narrow and deep: a policy decision, a money-moving call, a webhook, and an audit trail that must agree with each other at all times.

The product claim is structural — payment authority is confined to one module, and the LLM cannot reach it. Whatever architecture we pick must make that claim *enforceable*, not merely stated.

## Decision

A **modular monolith**:

1. One deployable Fastify API (`apps/api`) containing modules `intake`, `catalog`, `payments`, `approvals`, `webhooks`, `audit`, `jobs`, with enforced boundaries.
2. **Durable, event-driven background handling** via a Postgres-backed job queue, run in a worker role of the same image, for approvals, webhook processing, retries and timeouts.
3. A **separate SPA** (`apps/web`) deployed as a static site.
4. The **policy engine as a pure package** (`packages/policy`) — no I/O, no clock, no randomness.

Boundaries are enforced by package dependency direction, not by convention: `packages/llm` does not depend on the PayPal client, so it cannot call it, and CI can assert that.

## Alternatives considered

| Alternative | Assessment |
|---|---|
| **Microservices** — separate intake, policy, payments, approval services | Rejected. Every service boundary becomes a network boundary and a new partial-failure mode, precisely on the money path. The gap between "policy allowed" and "payment captured" would become a distributed transaction requiring outboxes and sagas across repos, built under deadline by five people. The benefits — independent scaling and deploys — are worth nothing at hackathon scale. Cost immediate, benefit hypothetical |
| **Serverless functions** | Rejected as the primary style. Cold starts hurt a conversational flow; local development and the Gate 3 "stranger runs it from the README" test get harder; durable multi-step approvals need an external orchestrator anyway; business logic fragmented across handlers makes a coherent audit trail harder |
| **Unstructured monolith** | Rejected. Fastest to write and fatal to the product claim. Without enforced boundaries, someone imports the PayPal client into the LLM path at 2 a.m. and the guardrail story quietly becomes untrue. The boundary is the product |
| **Agent framework** (tool-calling orchestration) | Rejected. Built around giving models tools; we are building the opposite. See [ADR 0004](0004-llm-has-no-tools-policy-in-code.md) |
| **Render Workflows instead of a Postgres queue** | Viable alternative, not chosen by default. Keeping job state in the same transaction as order state removes a class of "money moved but the follow-up was lost" bugs. Dissent and reversal condition in [tech-stack.md](../tech-stack.md#dissent-2--durable-jobs-postgres-queue-over-render-workflows) |

## Consequences

**Positive**

- One deploy, one log stream, one database transaction boundary around the money path.
- Local development is `docker compose up -d && pnpm dev`, which is also the Gate 3 requirement.
- A policy decision and its budget reservation commit atomically — the concurrency design in [er-diagram.md](../er-diagram.md#concurrency-budget-reservations) depends on this.
- Pure policy functions are exhaustively testable without infrastructure, which makes the three-configuration eval affordable.

**Negative**

- One deployable means one blast radius: a bad deploy takes down chat, approvals and webhooks together. Mitigated by CI gates and a small, reviewed surface.
- Module boundaries need active defense in review; they decay by default.
- Scaling is coarse-grained. Irrelevant before Nov 12.

**Neutral**

- The worker role runs the same image, so there is no second build pipeline.

## When we would extract a service

Only on a concrete trigger:

| Trigger | Extraction |
|---|---|
| The policy check is sold as a standalone developer API with external customers and separate SLAs | Wrap `packages/policy` in a thin HTTP service — it is already pure, so this is a wrapper, not a rewrite |
| Webhook volume or eval runs starve the request path of CPU | Scale the existing worker role first; split codebases only if that fails |
| Compliance requires separate credential custody for payments | Extract `payments` with its own secret scope |

None of these apply before Nov 12.
