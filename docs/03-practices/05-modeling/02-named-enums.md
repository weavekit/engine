---
title: Shared enum vocabularies
description: "Keep one status vocabulary across objects with a named enum."
---

# Shared enum vocabularies with named enums

A closed set that more than one object must agree on — a ticket's lifecycle status, a payment state,
a risk grade — is a **vocabulary**. If each object carries its own copy of the option list, the lists
drift ("pending" on one object, "waiting" on another) and only the database notices at write time.

A [named enum](../../01-guides/03-model/02-schema/06-named-enums.md) declares the vocabulary once and
lets every object reference it. The engine then backs all of them with a **single native PostgreSQL
enum type**.

## The scenario

A support product has two objects that both carry the ticket lifecycle:

- `tickets` — the current `status`;
- `ticket_events` — an append-only log whose `to_status` records the status a transition moved into.

Both must accept exactly the same values, and both should show the same localized labels.

## 1. Declare the vocabulary once

```jsonc
// enums/ticket_status.json
{
  "name": "ticket_status",
  "values": ["open", "pending", "resolved", "closed"],
  "labels": {
    "en": { "open": "Open", "pending": "Pending", "resolved": "Resolved", "closed": "Closed" },
    "fr": { "open": "Ouvert", "pending": "En attente", "resolved": "Résolu", "closed": "Fermé" }
  }
}
```

The file name equals the enum name equals the PostgreSQL type name (`ticket_status`).

## 2. Reference it from both objects

```jsonc
// objects/tickets/schema.json
{ "name": "status", "type": "enum", "enumType": "ticket_status", "default": "open" }

// objects/ticket_events/schema.json
{ "name": "to_status", "type": "enum", "enumType": "ticket_status", "required": true }
```

Neither field declares `options` — the values come from the declaration. `weave migrate` creates the
`ticket_status` type **once** and both columns use it.

## 3. What stays consistent for free

Because the values live in one place, every surface reads the same set:

- **REST metadata** — `GET /api/metadata?object=tickets` (and `ticket_events`) returns the same
  `options` plus the per-value `optionLabels`, so a front-end renders one vocabulary.
- **MCP** — `describe_object` shows an agent the same options for both objects, so it cannot invent a
  status the database rejects.
- **OpenAPI** — `weave openapi` emits one `components.schemas.ticket_status` that both object schemas
  `$ref`, instead of two duplicated inline enums.
- **TypeScript** — `weave types` emits one `TicketStatus` union used by both interfaces.

## 4. Evolving the vocabulary

Adding a status is a single edit:

```jsonc
"values": ["open", "pending", "resolved", "closed", "escalated"]
```

Run `weave migrate`; the engine issues `ALTER TYPE ticket_status ADD VALUE IF NOT EXISTS 'escalated'`
on managed tables, and both objects immediately accept it. Removing or renaming a value is **not**
supported (PostgreSQL cannot drop an enum label) — retire a value by leaving it declared and simply
not using it.

## Guardrails

- Run `weave enum:check` in CI: it validates every `enums/<name>.json` and every `enumType` reference
  in `objects/` without a database, so a typo (`ticket_stat`) fails the build instead of at write time.
- Adopted (read-only) tables are never altered — a named enum that mirrors an existing type is
  informational only.
- Keep the vocabulary small and stable. A set that is actually *data* (currencies, categories stored
  in a table) is a [dynamic `enum.options.from`](../../01-guides/03-model/02-schema/02-fields-and-types.md#enumoptions--static-or-data-driven),
  not a named enum.

## When to reach for it

| Situation | Use |
| --- | --- |
| One object, one closed set | inline `options` — no need to declare |
| Several objects share a closed set | **named enum** (this page) |
| Values come from another table's rows | `enum.options.from` |
| A record reference (navigate/expand) | [`relation`](../../01-guides/03-model/02-schema/03-relations.md) |

## Related

- [Named enums (reference)](../../01-guides/03-model/02-schema/06-named-enums.md)
- [CLI reference — `weave enum:list` / `enum:check`](../../01-guides/09-platform/02-cli.md)
- [RBAC](../../01-guides/04-access/02-rbac.md) — permissions are declared per object, independent of the vocabulary
