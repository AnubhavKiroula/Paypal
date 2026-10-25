# ADR 0003: Postgres is the source of truth; Elasticsearch is a non-authoritative mirror

- **Status:** Proposed — needs team review
- **Date:** 2026-10-25
- **Deciders:** `@TBD` (all five roles)
- **Related:** [er-diagram.md](../er-diagram.md) · [architecture.md](../architecture.md) · [tech-stack.md](../tech-stack.md)

## Context

Mandate needs two different things from its data layer:

1. **Correctness guarantees** — transactions, row locking, unique constraints. The budget reservation that prevents concurrent overspend and the unique constraints that prevent double capture and duplicate webhook processing are all database primitives.
2. **Search** — an audit log a human can search, and a "have we bought this before?" lookup for the dashboard.

Elasticsearch is a sponsor and serves the second need well. It does not serve the first, and a system with two stores that both claim authority has no authority at all.

## Decision

**Postgres is the single source of truth for every entity.** Elasticsearch holds a **one-way, non-authoritative mirror of `audit_log`**, used only for search.

| Rule | Statement |
|---|---|
| Direction | Postgres → Elasticsearch, never the reverse |
| Scope | `audit_log` only. No orders, decisions, reservations or approvals |
| Authority | Elasticsearch is **never** read to make a policy or payment decision |
| Failure | A failed mirror write is logged and retried; it never fails a user request ([failure mode 8](../architecture.md#5-failure-modes)) |
| Rebuild | The index is fully reconstructible from `audit_log` at any time |
| Correctness primitives | Transactions, `SELECT ... FOR UPDATE`, unique constraints and append-only grants all live in Postgres |

## Alternatives considered

| Alternative | Assessment |
|---|---|
| **Elasticsearch as the primary audit store** | Rejected. Near-real-time indexing and eventual visibility are acceptable for search and unacceptable for an audit trail that must prove what the agent did. Losing an audit write would be worse than losing search |
| **Dual-write with both treated as authoritative** | Rejected outright. Two authorities means reconciling disagreements in the one place we cannot afford ambiguity |
| **Postgres full-text search only, no Elasticsearch** | Technically sufficient at our data volume — hundreds of rows. Not chosen because Elastic is a sponsor doing genuine work in the dashboard. The author argues it should nonetheless be *optional locally*: see the dissent in [tech-stack.md](../tech-stack.md#dissent-1--elasticsearch-should-not-be-required-to-run-the-project-locally) |
| **Change-data-capture pipeline into Elasticsearch** | Rejected. Correct and far too much machinery for 21 days. A write-path mirror with retry is enough for an append-only table |

## Consequences

**Positive**

- One place to ask "what actually happened": Postgres. Disputes have a single answer.
- Elasticsearch can be down, slow or trial-expired without affecting correctness — which also defuses the sponsor-trial-expiry risk on the critical path.
- The mirror is append-only data, so it never needs update or delete reconciliation.

**Negative**

- Audit search can lag the database briefly, and the dashboard must not present stale search results as authoritative counts. Spend totals and pending-approval counts are read from Postgres, not from the index.
- A second store to run locally. See the dissent above.
- The mirror needs a reindex path, which must be exercised at least once before the demo rather than discovered during it.

**Neutral**

- `audit_log` is append-only at the grant level ([data model](../er-diagram.md#append-only-tables)), which is what makes a one-way mirror safe.
