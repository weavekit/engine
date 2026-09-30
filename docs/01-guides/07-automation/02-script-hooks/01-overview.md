---
title: Script subsystem
description: "Run user-authored server.js lifecycle hooks in an isolated sandbox around data writes."
---

# Script subsystem

The script subsystem runs user-authored hooks from `objects/<name>/server.js` in an **isolated
sandbox**. Hooks run around data writes — validation, pre-write mutation, post-write side effects —
and bridge back to the engine for any data or service access.

Script is an **optional subsystem**. It's disabled by default, and when it's off it isn't loaded at
all: no import, no workers, zero overhead.

> **Optional native dependency**: the sandbox backend uses `isolated-vm`, declared as an
> `optionalDependency`. If you don't enable the script subsystem, it's never installed or loaded. If
> it's missing at startup while the subsystem is enabled, the engine fails fast with
> `script.sandbox.unavailable` (`npm install isolated-vm`) instead of a raw module error.

## In this section

- [Authoring hooks](02-authoring.md) — the hook list, examples, and editing `server.js` over the API
- [Context API](03-context-api.md) — `this.*`, `this.db.objects`, and restricted SQL
- [Sandbox & errors](04-sandbox.md) — isolation, limits and failure semantics

## Enable

```ts
// weavekit.config.ts
export default {
  // ...
  subsystems: {
    script: {
      enabled: true,
      sandbox: {
        timeout: 5000,                 // overall hook timeout (ms)
        queryTimeout: 2000,            // per this.db call timeout (ms)
        memoryLimit: 64 * 1024 * 1024, // sandbox heap limit (bytes)
        maxConcurrentScripts: 10,      // concurrent hook executions (over → script.busy)
        maxObjectsPerQuery: 100,       // rows a script may fetch per db.objects(...).find() (clamped; global cap 1000)
        rls: { role: 'weavekit_query' }, // db.query row-level security role (on by default when script is enabled)
      },
      // services: { ... }             // optional: custom this.services implementations
    },
  },
};
```

## Programmatic use

Beyond `weave dev`, you can wire the dispatcher yourself:

```ts
import { createScriptDispatcher, createDataAccess, createPool, ObjectRegistry } from '@weave-kit/engine';

const dispatcher = await createScriptDispatcher({
  objectsDir: join(projectRoot, 'objects'),
  registry,
  pool,
  dataAccess,                       // RBAC-decorated — serves this.db.objects
  config: { sandbox: { timeout: 5000, queryTimeout: 2000 } },
});
const dataAccess = createDataAccess({ script: dispatcher }); // hooks now fire on writes
// ...
await dispatcher.close();           // terminates all workers
```

## Related

- [Audit](../../09-platform/03-audit.md) — after-hook failures are recorded as `isError` events
- [RBAC](../../04-access/02-rbac.md) — the permissions `this.db.objects` enforces
- [Workflow](../../06-workflow/03-lifecycle.md) — transition hooks (`onEnter`/`onExit`/…)
