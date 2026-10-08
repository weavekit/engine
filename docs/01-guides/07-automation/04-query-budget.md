---
title: Query budget
description: "One budget that bounds what any single read or query may cost — across every protocol."
---

# Query budget

The **query budget** is one object that caps the cost of a single read/query. It is enforced in the
shared data-access layer, in restricted SQL, and in the protocol adapters, so a caller **cannot bypass
a limit by switching protocol** (REST → MCP → GraphQL).

```ts
// weavekit.config.ts
export default {
  // ...
  queryBudget: {
    maxRows: 500,        // list/find row cap (REST / MCP / GraphQL)
    maxDepth: 8,         // GraphQL selection depth
    maxJoins: 5,         // restricted SQL joins
    maxFilters: 20,      // filter conditions (incl. $or members)
    maxSorts: 4,         // sort keys
    maxSqlLength: 10_000, // restricted SQL statement length (chars)
    statementTimeoutMs: 3_000, // per-query statement_timeout
  },
};
```

Every key is optional; absent keys fall back to `QUERY_BUDGET_DEFAULTS`:

| Key | Default | Bounds |
| --- | --- | --- |
| `maxRows` | `1000` | rows returned by a list/find |
| `maxDepth` | `10` | GraphQL selection depth |
| `maxJoins` | `8` | JOINs in a restricted SQL query |
| `maxFilters` | `50` | filter conditions (each `$or` member counts) |
| `maxSorts` | `8` | sort keys |
| `maxSqlLength` | `20000` | restricted SQL length (characters) |
| `statementTimeoutMs` | `5000` | database `statement_timeout` per query |

## Behavior

- A request that exceeds a limit fails **closed** with `query.budget.exceeded` (the offending `limit`
  and `max` are in the error params) — never a silent truncation.
- Resolution is centralized: `resolveQueryBudget(partial)` merges your config over the defaults and
  rejects non-positive/invalid values. `resolveQueryBudget` / `QUERY_BUDGET_DEFAULTS` are exported for
  hosts that build data-access directly.
- **Per-context override** — `DataAccessContext.budget` overrides the instance budget for one
  operation (e.g. a trusted internal job), without changing global config.

This is deliberately **not** the same as [Quotas](03-quotas.md): quotas are durable, cross-request
usage counters (`weavekit_counters`); the query budget is a per-query structural cap.

## Related
- [Quotas](03-quotas.md) — durable usage budgets
- [RBAC](../04-access/02-rbac.md) — what a scoped read is allowed to see
- [GraphQL](../08-integration/06-graphql.md) — depth/complexity hardening at the adapter
- [Public API & dependency budget](../../04-reference/01-api/02-public-api.md)
