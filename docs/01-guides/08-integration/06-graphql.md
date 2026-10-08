---
title: "GraphQL"
description: "A read/write GraphQL endpoint compiled from the same schema.json."
---
# GraphQL

The GraphQL adapter compiles the **same `objects/<name>/schema.json`** into a GraphQL schema and mounts
a `/graphql` endpoint — a third protocol alongside REST and MCP, sharing one data model and one
security layer. It is **opt-in** (disabled unless declared).

```ts
// weavekit.config.ts
import type { EngineConfig } from '@weave-kit/engine';

export default {
  adapters: { graphql: { enabled: true, prefix: '/graphql' } }, // prefix defaults to /graphql
} satisfies EngineConfig;
```

Authentication is the same Bearer API key as REST/MCP; a missing/invalid key is a plain `401`.
Authorization is **not** re-implemented: every field resolves through the RBAC-decorated data-access
layer, so row scope (`own`/`department`), field exclusion and write auditing behave exactly as they do
over REST/MCP.

## The schema

For an object `leads` the compiler emits:

```graphql
type Leads { weave_id: ID!, title: String, status: LeadStatus, owner: Users, lines: [OrderLines!]!, tags: [Tags!]! }
type LeadsPage { rows: [Leads!]!, total: Int! }

type Query {
  leads(filter: JSON, sort: [SortInput!], limit: Int, offset: Int): LeadsPage!
  leads_by_id(id: ID!): Leads
}
type Mutation {
  createLeads(data: LeadsCreateInput!): Leads!
  updateLeads(id: ID!, changes: LeadsUpdateInput!): Leads!
  deleteLeads(id: ID!): Boolean!
  transitionLeads(id: ID!, action: String!, payload: JSON): Leads!   # only when the object has a workflow
}
```

- **`id` is the record's `weave_id`** (its `record_key`), not the raw primary key — read it from a
  result (`weave_id`) and pass it back.
- `filter` is the free-form JSON filter (exact values, operator objects, top-level `$or`) — the same
  contract as REST/MCP. `sort` is a `[SortInput!]` (`{ field, dir: asc|desc }`).
- **Relations** are nested: a `relation`/`user`/`department` field resolves to the target object (or
  its raw id when the target isn't a modeled object), `details`/`multiRelation` to `[Target!]!`.
  Nested reads are batched per request, so a list of N records with a relation is one query per layer.
- `create`/`update` input types expose only writable, non-excluded fields; the primary key is immutable
  on update. Writes go through the same data-access path, so RBAC denials surface as
  `rbac.denied.create|update|delete` and every write is audited.

Errors use the GraphQL-over-HTTP shape: HTTP `200` with `{ errors: [{ message, extensions: { code } }] }`
(`code` is the engine's stable error code). Authentication failures stay `401`.

## Hardening

```ts
adapters: {
  graphql: {
    enabled: true,
    security: {
      maxDepth: 10,                                   // default 10
      maxComplexity: 5000,                            // optional
      maxAliases: 50,                                 // optional
      introspection: false,                           // default true
      allowList: { enabled: true, file: 'graphql-allowlist.json' }, // default off
    },
    rateLimit: { windowMs: 60_000, max: 600 },        // per Bearer key
  },
},
```

- **depth / complexity / alias** limits are enforced before execution; a rejected query returns
  `graphql.depthExceeded` / `graphql.complexityExceeded` / `graphql.aliasExceeded`.
- **`introspection: false`** rejects `__schema` / `__type`.
- **Allow list** (`allowList.file`, Git-versioned): only operations whose hash is listed run; others
  return `graphql.allowList.denied`. The hash is `operationHash(document)` (sha256 of the printed
  document). Keep the file in your repository so the approved surface is reviewable.

## Export the SDL

```sh
weave graphql:schema --out schema.graphql   # or omit --out to print to stdout
```

The export is offline (no database) — useful for client codegen or review.

## Related

- [Schema guide](../03-model/02-schema/01-overview.md) — the single source of truth
- [RBAC](../04-access/02-rbac.md) — the row- and field-level rules GraphQL reuses
- [CLI reference](../09-platform/02-cli.md) — `weave graphql:schema`
- [Public API](../../04-reference/01-api/02-public-api.md) — `buildGraphQLSchema`, `registerGraphQL`
