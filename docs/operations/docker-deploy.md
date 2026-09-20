# Deploying with Docker

Run the engine as a self-contained Node process in a container, with no hand-rolled systemd units.
The engine listens on `0.0.0.0` (container-friendly) and reads `PORT` (default 3000) and
`DATABASE_URL` from the environment.

## Background

`weave dev` is fine for development, but production needs something repeatable: the same image builds
and runs identically on your laptop, in CI, and on the server. Hand-provisioning Node, the project,
and systemd on every host is exactly the kind of drift that bites later. A container captures the
whole runtime — Node, dependencies, config, schema — in one artifact.

## Benefits

- **One image, run anywhere** — the exact build you tested in CI is the build that runs in production, with no "works on my machine".
- **No Node install on the host** — the official `node` image carries the runtime; you just run the container.
- **Easy to operate** — logs to stdout, configuration via environment variables, clean restarts; it fits any orchestrator (compose, k8s, a container service).
- **Explicit migrations** — the image never migrates on startup, so replicas cannot race each other on DDL. You run `weave migrate` deliberately as a deploy step.

## When to use this

Choose Docker when:

- You run the engine on a server you don't want to hand-maintain (no manual Node/systemd setup).
- You want repeatable builds and clean rollbacks (deploy the previous image).
- Your platform already runs containers (k8s, Docker Swarm, a managed container service, or just `docker compose` on a VM).

If you manage one small VM and prefer classic processes, the same two commands (`weave build` →
`node dist/main.js`) work under systemd/pm2. The container is a wrapper, not a requirement.

## 1. Containerize the project

`Dockerfile` at the project root:

```dockerfile
FROM node:24-slim

WORKDIR /app

# dependencies first for layer caching
COPY package.json ./
RUN npm install

# source + schema + config
COPY . .

# production bundle: dist/main.js (entry = root main.ts)
RUN npx weave build

# migrate is a deployment step (see below), not startup — DDL stays explicit
CMD ["node", "dist/main.js"]
```

> `npm install` pulls `@weave-kit/engine` from your registry. If you deploy from a private registry,
> make sure npm can reach it (registry URL / auth via environment variables) before building the
> image.

## 2. Compose: engine + PostgreSQL

`docker-compose.yml`:

```yaml
services:
  db:
    image: postgres:17
    environment:
      POSTGRES_USER: weavekit
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set in .env}
      POSTGRES_DB: crm
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U weavekit -d crm"]
      interval: 5s
      timeout: 3s
      retries: 10

  engine:
    build: .
    environment:
      DATABASE_URL: postgres://weavekit:${POSTGRES_PASSWORD}@db:5432/crm
      PORT: "3000"
    ports:
      - "3000:3000"
    depends_on:
      db:
        condition: service_healthy

volumes:
  pgdata:
```

`.env` (gitignored) supplies secrets:

```
POSTGRES_PASSWORD=change-me
```

## Changing the port

The engine never hardcodes a port — it reads `PORT` (default 3000). Where you change it depends on how
you run it:

- **Container (`docker compose`)** — set `PORT` in the compose `environment` and remap the host port in `ports`. To expose the engine on host port `8080` while it listens on `3000` inside the container:

  ```yaml
  environment:
    PORT: "3000"
  ports:
    - "8080:3000"
  ```

  (or set `PORT: "8080"` and map `"8080:8080"` — pick one convention and stay consistent, since the healthcheck below probes `http://127.0.0.1:3000/health`.)
- **Local production (`node dist/main.js`)** — the scaffolded `main.ts` reads `PORT` from the environment, e.g. `PORT=8080 node dist/main.js`. A `# PORT=3000` hint ships in the project's `.env.example`.
- **Development (`weave dev`)** — pass the port explicitly: `weave dev --port 8080`.

The reverse-proxy practice relies on the same environment-driven pattern: the proxy points at the
engine's internal port, whichever you chose.

## 3. Migrate, then start

DDL stays explicit: the container starts the app and never migrates on its own. Run migration once
(and after every schema change) as a one-off:

```sh
docker compose run --rm engine npx weave migrate
docker compose up -d
```

The REST API is then at `http://localhost:3000/api/objects/leads` and the MCP endpoint at
`http://localhost:3000/mcp`.

## 4. Production notes

- **Run the app as a non-root user** — add `USER node` before `CMD` in the Dockerfile (the official image ships a `node` user).
- **Never run `weave migrate` from app startup** — two replicas racing DDL is exactly what the explicit-migration design avoids. Do it as a deploy step or a separate job.
- **Sessions are in-memory** (per engine). Restarting the engine drops all MCP sessions; clients reconnect with a fresh `initialize`. Keep a single replica, or plan for sticky routing if you scale out.
- **Logs** — the app logs `weavekit engine listening on http://localhost:<port>` on start. Route everything to stdout and let the platform collect it.
- **Health checks** — the engine exposes `/health` (liveness — the process is up, never touches the database) and `/ready` (readiness — runs `SELECT 1` against PostgreSQL, 200 when up / 503 when down). Wire a container healthcheck to `/health` and the orchestration readiness probe to `/ready`:

  ```yaml
  healthcheck:
    test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
    interval: 10s
    timeout: 3s
    retries: 3
  ```

  `GET /version` returns `{ name, version }` for troubleshooting and compatibility checks. These routes are always registered, independent of adapter config.

## Next

- [Reverse proxy + TLS](reverse-proxy.md) — terminate HTTPS in front of the engine for public agents
- [MCP host setup](../practices/connecting-mcp-hosts.md) — point Claude Desktop / Cursor / your gateway at `/mcp`
