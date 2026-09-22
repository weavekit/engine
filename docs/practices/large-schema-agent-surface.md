---
description: "Serve dozens of objects to one agent without exploding the tool surface — the fixed registry surface and the discovery-first workflow."
---

# Exposing a large schema to an agent

A production database rarely has three tables. It has forty — customers, orders, invoices, shipments,
tickets, products, warehouses… You want one agent to help operate that domain, not forty hand-built
tools that change every time someone adds a table.

This practice is about the **tool-surface budget**: how the engine keeps an agent's tool list small
and stable no matter how many objects you describe, and the discovery workflow the agent uses in
return.

## Background

It is tempting to expose one tool per object per operation (`search_orders`, `create_orders`, …). It
works for a demo. At scale it quietly breaks:

- **Context cost** — every tool's schema is tokens in the model's context, competing with the actual
  task. Sixty tools burn budget before the agent reads a single row.
- **Tool selection degrades** — the more near-identical tools there are, the more often the model
  picks the wrong one.
- **Churn** — adding an object regenerates the whole surface, so every client's cached tool list
  drifts.

The engine takes the opposite approach: a **fixed registry** surface whose size never depends on the
object count.

## Benefits

- **Constant surface** — the tool list is always at most seven tools: `list_objects`,
  `describe_object`, and the five generic CRUD tools (`search_records`, `get_record`,
  `create_record`, `update_record`, `delete_record`). Adding objects never adds tools.
- **Discovery over enumeration** — the agent asks `list_objects` what exists, then `describe_object`
  for the one it needs. Detail is loaded on demand, not up front.
- **RBAC still scales per object** — an operation tool appears only if the identity may perform it on
  *at least one* object, and every call is re-checked against the target object's permissions.
- **Nothing else changes** — the same audit trail (`mcp.tool.<name>`), rate limiting, and guardrails
  apply. The agent contract is smaller; the safety contract is identical.

## When to use this

Choose the registry surface (it is the default — there is nothing to switch on) when:

- You expose **many objects** to an agent — roughly ten or more, and a wide domain.
- You want **one agent** to cover that domain rather than a per-task tool.
- Objects are added over time and you do not want to re-ship a tool list on every schema change.

If you only expose a couple of tables with a small, stable set of humans, the static-identity
walkthrough in [Integrating an existing CRM with MCP](existing-crm-to-mcp.md) is the shortest path —
the surface is the same, it just fits on one page there.

## Scenario

An internal back-office database with ~40 objects (customers, orders, invoices, shipments, tickets,
products, warehouses, …). Two roles operate it through one agent:

- `viewer` — read-only across the domain (no writes).
- `admin` — full CRUD.

Both connect as the **same agent key**; the on-behalf-of identity (and its roles) decides what the
session can see and do.

## The agent workflow

The agent does not need forty tools; it needs a map and a small vocabulary. A typical session:

```ts
// 1. discover what exists (filtered to the identity's read scope)
await client.callTool({ name: 'list_objects', arguments: {} });
// → { objects: [{ name: 'orders', labels: { en: 'Order' } }, …] }

// 2. learn one object's fields, relations and the identity's permissions
await client.callTool({ name: 'describe_object', arguments: { name: 'orders' } });
// → { fields: [...], relations: [...], permissions: { read, create, update, delete } }

// 3. act — every call names the object it targets
await client.callTool({
  name: 'search_records',
  arguments: { object: 'orders', filter: { status: 'pending' }, limit: 20 },
});
await client.callTool({ name: 'get_record', arguments: { object: 'orders', id: 'O-1001' } });
await client.callTool({
  name: 'update_record',
  arguments: { object: 'orders', id: 'O-1001', changes: { status: 'paid' } },
});
```

`describe_object` is the pivot: it returns exactly the fields the identity may see (RBAC `exclude` is
already applied), the relations with their targets, and the identity's effective operations on that
object. From there the generic tools are self-explanatory.

## What the surface looks like

Always present:

| Tool | Purpose |
| --- | --- |
| `list_objects` | objects the identity can read (`[{ name, labels }]`) |
| `describe_object` | one object's schema + the identity's effective permissions |

Present when the identity holds the capability on at least one object:

| Tool | Fires when | Key args |
| --- | --- | --- |
| `search_records` | any readable object | `object`, `filter`, `sort`, `limit` (≤1000), `offset`, `fields` |
| `get_record` | any readable object | `object`, `id` |
| `create_record` | any object with `create: true` | `object`, `data` |
| `update_record` | any object with a non-empty update allowlist | `object`, `id`, `changes` |
| `delete_record` | any object with `delete: true` | `object`, `id` |

A `viewer`-only identity therefore sees three tools (`list_objects`, `describe_object`,
`search_records`, plus `get_record` if reads are allowed) — regardless of whether the schema has four
objects or four hundred. An `admin` sees all seven.

## RBAC & limits

- **Operation gating at compile time** — an operation tool is withheld entirely when *no* object
  grants it (a read-only role never sees `create_record`).
- **Per-object enforcement at call time** — the tool, once present, is still checked against the
  target object: a role that may read one object but not another gets a denial `isError` on the
  second, and the attempt is audited.
- **Field & row scope** — `fields.exclude` columns are stripped from results and rejected on write;
  `read: own | team | all` scopes the rows.
- **Limits** — `search_records` caps `limit` at 1000; the per-agent-key sliding window (default
  100 calls / 60s) and alerts apply as usual. Every call writes `mcp.tool.<name>` to
  `weavekit_audit`.

## Known constraints

- **Discovery is a step, not free** — the generic schemas intentionally do not enumerate per-object
  fields, so a well-behaved agent calls `describe_object` before acting. Prompts and system messages
  should tell it to.
- **The primary key argument is `id`** — a string, whatever the underlying column type; the
  data-access layer validates and coerces it.
- **No per-field parameter hints** — you cannot pin an enum's options into the `search_records`
  schema. Field semantics live in `describe_object`; see
  [Designing an agent-friendly schema](agent-friendly-schema.md) to make that description good.

## Next

- [Designing an agent-friendly schema](agent-friendly-schema.md) — labels, descriptions, types and
  RBAC that make `describe_object` useful.
- [MCP](../guides/mcp.md) — the full adapter contract (sessions, identities, guardrails).
- [Connecting MCP hosts](connecting-mcp-hosts.md) — Claude Desktop / Cursor / gateways.
- [RBAC](../guides/rbac.md) — what each role contributes to the surface.
