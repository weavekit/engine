---
description: "Shape your objects, fields, types and permissions so an AI agent can discover and safely operate them through MCP."
---

# Designing an agent-friendly schema

When an agent works through MCP it only ever sees what the engine tells it: the objects from
`list_objects` and one object's shape from `describe_object`. The quality of that metadata is the
ceiling on what the agent can do safely — a vague field name or an over-broad permission reads to the
model as an invitation to guess.

This practice is the schema-side companion to
[Exposing a large schema to an agent](large-schema-agent-surface.md): that page is about *how* the
agent discovers and acts; this one is about making what it discovers worth acting on.

## Why it matters

The agent never reads your TypeScript or your migration history. It reads `describe_object`, which
surfaces **field names, labels, descriptions, types, relations, enum options, and your effective
permissions** — already filtered by RBAC. Everything you intend the agent to understand has to be in
that description. Treat it as the API documentation your most literal consumer will ever read.

## Names and labels

- **Name in `snake_case`, one scalar primary key.** Names are the agent's vocabulary; `shipped_at`
  beats `shipdate`. The primary key can be any scalar type, but a single string column (a UUID or a
  human-readable code like `doc_no`) keeps relation arguments simple.
- **Add `labels` for display, keep `name` for identity.** `labels` (per locale) give the agent a
  human phrase to show ("Order"), while `name` stays the stable machine handle.
- **Write a `description` on every field the agent must not misread.** A one-line `description` is
  the difference between the agent writing `status: "shipped"` and inventing `status: "sent"`.

```jsonc
// objects/orders/schema.json
{
  "name": "orders",
  "labels": { "en": "Order" },
  "fields": [
    { "name": "id", "type": "string", "primary": true, "description": "Order code, e.g. O-1001" },
    { "name": "customer_id", "type": "relation", "target": "customers", "required": true },
    {
      "name": "status",
      "type": "enum",
      "options": ["pending", "paid", "cancelled"],
      "description": "Lifecycle state; only pending → paid/cancelled is valid"
    },
    { "name": "amount", "type": "currency" },
    { "name": "created_at", "type": "datetime" }
  ]
}
```

## Self-documenting types

Field types carry meaning the agent can use — prefer the most specific type that fits:

- **`enum` over free `string`** for any closed set. The options appear in `describe_object`, so the
  agent picks a valid value instead of guessing.
- **Semantic types over raw primitives** — `email`, `phone`, `image`, `person`, `department`,
  `firstName`/`lastName`. They inherit storage from a primitive but tell the agent (and the frontend)
  what the value *is*.
- **Business semantics via custom field types** — when a domain concept recurs (`money`, `rating`,
  `address`), register a namespaced type over a base primitive instead of re-explaining it per field.
  See [Custom field types](../reference/custom-field-types.md).
- **Computed values as formulas, not writable columns** — `formula` fields are read-only and
  persisted, so the agent cannot corrupt a derived total.
- **`titleTemplate`** gives a record a readable title (e.g. `"{id} · {status}"`), which makes search
  and get results legible to the model.

## Relations

Relations are how the agent navigates the domain, so get the targets and cardinality right:

- **`relation`** — a reference to another object's primary key; the agent passes the target's id.
- **`details`** — strong 1:N ownership managed through the child object's own CRUD, not nested
  writes.
- **`multiRelation`** — a multi-select of references (stored as an array).

Name relation fields after their target (`customer_id`, not `cust`) and mark the required ones; the
agent reads cardinality from the relation list in `describe_object`.

## RBAC an agent can live with

Permissions are part of the description the agent sees, and the real enforcement boundary at call
time. Design them so "what the agent sees" and "what it may do" agree:

- **Start from the role's job.** Give `viewer` only a `read` scope; give writing roles an explicit
  `update` allowlist rather than `true`.
- **Scope reads by rows.** `read: "own"` (with an `ownership: true` field) or `read: "team"` (with a
  team marker) keeps an agent inside one person's data.
- **Hide what must not be read.** `fields.exclude: ["secret"]` removes the column from
  `describe_object`, from search results, and from writes — the agent cannot reference what it cannot
  see.
- **Whitelist writes.** A non-empty `update` list (and `create`/`fields.create`) means the agent can
  only touch the columns you named; anything else is a denial, not a silent no-op.

```jsonc
"permissions": {
  "viewer": { "read": "all", "fields": { "exclude": ["internal_note"] } },
  "agent":  { "read": "own", "create": true, "update": ["status", "amount"] }
}
```

## Narrow high-risk writes with custom tools

Generic CRUD is the floor, not the ceiling. When an operation has business rules an agent should not
re-derive — refunds, credits, reassignments — model it as a **custom tool** with its own schema, role
allowlist, and guardrail policy (including `requireApproval` for a human-in-the-loop step). The agent
then calls your named operation instead of composing raw updates. See
[Custom tools, guardrails & audit replay](../guides/custom-tools-and-guardrails.md) and
[Approvals](../guides/approvals.md).

## Anti-patterns

- **`read: "all"` on a table with sensitive columns** — the agent sees (and can exfiltrate) every
  field it can read. Exclude first.
- **`update: true` where an allowlist would do** — a broad write surface is how an agent "helpfully"
  edits the wrong column.
- **Free-form `string` for closed sets** — the agent invents values that fail validation, or worse,
  writes plausible-but-wrong ones into an unconstrained column.
- **Undescribed fields with cryptic names** — `c_stat`, `flag2`. The agent will guess; document them
  or exclude them.

## Next

- [Exposing a large schema to an agent](large-schema-agent-surface.md) — the fixed registry surface
  and the discovery workflow this metadata serves.
- [Schema guide](../guides/schema.md) — fields, relations, computed fields and validation.
- [RBAC](../guides/rbac.md) — roles, permissions and row scopes in full.
- [MCP](../guides/mcp.md) — the adapter contract.
