# Integrating an existing CRM with MCP

A real end-to-end case: the customer already runs a CRM backed by PostgreSQL. They want AI agents to query and update customer and order data through MCP — without the engine touching a single table they own.

Follow the steps in order against your own PostgreSQL; every command is copy-paste runnable.

## Background

Most teams we talk to already have a working system — a CRM with years of customer and order data, a team that lives in that data, and a growing list of "could an AI just handle this?" tasks. Rewriting the system around a new stack is not on the table; neither is giving an agent raw database access.

This practice is the minimal path that fits that reality: run the engine as a sidecar, describe the tables you already own in `schema.json`, and let agents operate them through MCP. No data migration, no schema rewrite, no new source of truth.

## Benefits

- **Zero risk to existing tables** — `weave migrate` only validates that declared fields are real columns; it never emits `ALTER` for a table you own unless the object opts in with `"alter": true` (additive-only DDL: ADD COLUMN / ADD CONSTRAINT / ADD FK / CREATE INDEX — never type changes or drops).
- **Fast to stand up** — one `schema.json` per table you want to expose, one config file, and the tool surface appears automatically.
- **Your data never moves** — the agent talks to the tables where the data already lives; there is no copy, no ETL, no export.
- **Two-layer security out of the box** — the agent's API key authenticates it, the on-behalf-of ref binds each session to a specific CRM user, and RBAC trims the tools that user can see and use.
- **Full audit trail** — every tool call writes to `weavekit_audit` with the agent key and the acting user, so you can always answer "what did the AI touch?"

## When to use this

Choose the static-directory path (this practice) when:

- The set of humans an agent may act for is **small and stable** (a few sales reps, one manager), so hardcoding `ref → roles` in config is not a maintenance burden.
- You want the **fastest possible first deployment** — zero code, just schema + config.
- You already have, or are willing to accept, a config edit + restart when roles change.

If your user base is dynamic or lives in a database you already manage, use [plugging in your own user store](bring-your-own-user-store.md) instead — same engine, identity resolved by your own resolver instead of a static list.

## Scenario

- Customer CRM tables `customers` / `orders` exist with years of data (we never ALTER them).
- Roles: `sales` (own rows only, no delete) and `manager` (everything).
- Identity directory is **static** (`X-Weavekit-On-Behalf-Of` refs map to RBAC subjects in config).
- The engine runs as a **sidecar service** next to the CRM, bridging the agent to the customer database.

```
AI agent (Claude / Cursor / SDK client)        customer environment
        │  MCP (streamable HTTP)               │
        ▼                                      ▼
   weavekit engine                        customer PostgreSQL
   /mcp  ──── DATABASE_URL ───────────▶  customers / orders
```

## 1. The customer's existing tables

These already live in the customer database. The engine will only **validate** that the declared fields are real columns — it never emits DDL for them.

```sql
CREATE TABLE customers (
  id         VARCHAR(36)  PRIMARY KEY,          -- e.g. UUID
  name       VARCHAR(255) NOT NULL,
  email      VARCHAR(255),
  owner_id   VARCHAR(255),                      -- owning sales rep (row-level scope)
  created_at TIMESTAMPTZ  DEFAULT now()
);

CREATE TABLE orders (
  id          VARCHAR(36)  PRIMARY KEY,
  customer_id VARCHAR(36)  NOT NULL REFERENCES customers(id),
  amount      NUMERIC(12,2),
  status      VARCHAR(20)  DEFAULT 'pending',   -- pending | paid | cancelled
  owner_id    VARCHAR(255),
  created_at  TIMESTAMPTZ  DEFAULT now()
);
```

## 2. Scaffold the engine project

```sh
create-weavekit-app crm-agent --yes
cd crm-agent
```

Remove the example object and describe the customer's tables instead:

```sh
rm -rf objects/leads
```

## 3. Point the engine at the customer database

```sh
cp .env.example .env
# DATABASE_URL=postgres://weavekit:xxxx@crm-db.internal:5432/crm
```

Use a dedicated PostgreSQL account with **minimal privileges** (read-only is enough for an agent that only queries). Engine RBAC is the second layer — the DB account is the first.

## 4. Describe the existing tables in schema.json

Field names must match real column names. The object name equals the table name.

`objects/customers/schema.json`:

```jsonc
{
  "name": "customers",
  "fields": [
    { "name": "id", "type": "string", "primary": true },
    { "name": "name", "type": "string", "required": true },
    { "name": "email", "type": "string" },
    { "name": "owner_id", "type": "string", "ownership": true },
    { "name": "created_at", "type": "datetime" }
  ],
  "permissions": {
    "sales":   { "read": "own", "create": true, "update": ["name", "email"], "delete": false },
    "manager": { "read": "all", "create": true, "update": true, "delete": true }
  }
}
```

`objects/orders/schema.json` — the `customer_id` relation maps to the target's primary key:

```jsonc
{
  "name": "orders",
  "fields": [
    { "name": "id", "type": "string", "primary": true },
    { "name": "customer_id", "type": "relation", "target": "customers", "required": true },
    { "name": "amount", "type": "currency" },
    { "name": "status", "type": "enum", "options": ["pending", "paid", "cancelled"] },
    { "name": "owner_id", "type": "string", "ownership": true },
    { "name": "created_at", "type": "datetime" }
  ],
  "permissions": {
    "sales":   { "read": "own", "create": true, "update": ["amount", "status"], "delete": false },
    "manager": { "read": "all", "create": true, "update": true, "delete": true }
  }
}
```

## 5. `weave migrate` — read-only branch for existing tables

`weave migrate` is the DDL entry point. For each object it asks PostgreSQL whether a table by that name exists:

- **No table** → engine generates `CREATE` (greenfield).
- **Table exists** → engine only verifies every declared field is a real column; **zero DDL** is generated (`object.field.columnMissing` aborts otherwise).
- **`"alter": true`** (top-level in an object's `schema.json`) opts that object into additive auto-DDL on schema changes — **additive-only**: ADD COLUMN / ADD CONSTRAINT / ADD FK / CREATE INDEX. Column types are never altered, columns never dropped, and a table missing its declared primary key still aborts.

```sh
weave migrate --dry-run            # preview: statements: [] — nothing will touch the existing tables
weave migrate              # executes (still zero DDL for existing tables), registers metadata cache
```

> **Danger**: if you typo an object name so it does not match the real table, the engine will `CREATE` a brand-new table instead of validating. Double-check `objects/<name>` equals the actual table name before migrating against a customer database.

Verified output from this case:

```json
{ "objects": ["customers", "orders"], "statements": [], "applied": [], "dryRun": false }
```

## 6. Configure authentication and the identity directory

`weavekit.config.ts`:

```ts
export default {
  schemaDir: '.',
  auth: {
    source: {
      // agent-level credentials (each agent gets its own key)
      'sk-agent-claude': { id: 'agent-claude', roles: ['agent'] },
      'sk-agent-cursor': { id: 'agent-cursor', roles: ['agent'] },
    },
  },
  adapters: {
    rest: { enabled: false },          // MCP-only customer: turn REST off
    mcp: {
      identities: {
        // on-behalf-of directory: ref → RBAC subject.
        // "alice" is a sales rep in the customer's CRM; roles match the schema permissions above.
        alice:   { id: 'u-alice', roles: ['sales'] },
        sarah:   { id: 'u-sarah', roles: ['sales'] },
        alex:    { id: 'u-alex',   roles: ['manager'] },
      },
      guardrails: {
        rateLimit: { windowMs: 60_000, max: 100 },
        alerts: { channel: 'console' },       // or webhook/slack
      },
    },
  },
} satisfies EngineConfig;
```

`mcp.identities` is the static directory: the ref in the `X-Weavekit-On-Behalf-Of` header resolves here, and the resulting `RbacSubject` decides the whole tool surface. Missing/unknown refs are rejected at session establishment.

## 7. Start the engine

```sh
weave dev        # local development (no DDL — tables already exist / previously migrated)
# production:
weave build      # → dist/main.js
node dist/main.js # run under systemd / pm2
```

## 8. Connect an agent

Two identity dimensions are required on every MCP request:

| Header | Meaning |
| --- | --- |
| `Authorization: Bearer <apiKey>` | which agent (401 on missing/bad key, before the transport) |
| `X-Weavekit-On-Behalf-Of: <ref>` | which CRM user the session acts as (decides the RBAC tool surface) |

SDK client:

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const transport = new StreamableHTTPClientTransport(new URL('/mcp', baseUrl), {
  requestInit: {
    headers: {
      authorization: 'Bearer sk-agent-claude',
      'x-weavekit-on-behalf-of': 'alice',
    },
  },
});
const client = new Client({ name: 'crm-agent', version: '1.0.0' });
await client.connect(transport);
```

Claude Desktop / Cursor MCP servers point at `https://agent.crm.com/mcp` with those two headers configured.

## 9. Tool surface per identity

Compiled from RBAC at session bind time (and re-enforced at call time):

- **alice (sales)** → `search_customers` / `get_customers` / `create_customers` / `update_customers` (no delete); same for `orders`. Queries are scoped to `owner_id = 'u-alice'` rows.
- **alex (manager)** → full CRUD on both objects, all rows.
- Primary-key args are named after the schema's `primary: true` field (`id` here); relation fields (`customer_id`) take the target's primary-key type — a string.

## 10. Audit trail

Every tool call writes a `mcp.tool.<name>` row to `weavekit_audit`: `actorId` = agent key, `meta = { onBehalfOf, subjectId, roles, agentLabel, tool }`. RBAC denials and failures are recorded as `isError`. The customer can inspect what agents did to their database:

```sql
SELECT ts, actor_id, action, object, is_error FROM weavekit_audit WHERE action LIKE 'mcp.tool.%' ORDER BY ts DESC;
```

## Known constraints of the static-directory approach

- **Identity directory is hardcoded** in config (`alice → sales`) and is independent of the CRM's own user table. Role changes require a config edit + restart. Fine for a small, stable user set; for a dynamic user base you need an `IdentityResolver` backed by the customer's user store.
- **Bypasses the CRM business layer**: MCP tools write the tables directly, so application-level validation/orchestration in the CRM is skipped (DB triggers still fire).
- **Table-shape requirements**: one single-column scalar primary key, snake_case column names, no composite keys, or schema validation rejects the object.
- **Relation values must be strings**: the data-access validator types relation writes as record ids (`validate.ts`), so use string primary keys (UUID is the natural fit) — an integer primary key would need string-typed writes.
- **PG RLS is not activated by the engine**: row-level safety comes from the RBAC layer's generated `WHERE` clauses, not from `row_security`.
